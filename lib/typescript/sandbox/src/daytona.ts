import { Daytona, type CreateSandboxFromSnapshotParams, type Sandbox } from "@daytona/sdk"
import { createHmac } from "node:crypto"
import { quoteArgv } from "./argv"
import {
  SandboxNotFoundError,
  SandboxUnavailableError,
  sandboxProviderHttpDetails,
  type CreateSandboxInput,
  type CreatedSandbox,
  type ExecResult,
  type PreviewLink,
  type SandboxDriver,
  type TreeEntry,
} from "./types"

export const PROVIDER = "daytona"

/** Where the customer's repository is checked out, and the only path that survives a stop. */
export const WORKSPACE_DIR = "/home/daytona/workspace"

/** Daytona snapshots have a fixed machine size; these values must match `build-snapshot.ts`. */
export const SNAPSHOT_RESOURCES = { cpu: 2, memoryGib: 4, diskGib: 10 } as const

/** A stopped container preserves its workspace but still bills disk until Daytona archives it. */
export const AUTO_ARCHIVE_AFTER_STOP_MINUTES = 1
export const DAYTONA_REQUEST_TIMEOUT_MS = 60_000
export const DAYTONA_DELETE_TIMEOUT_SECONDS = DAYTONA_REQUEST_TIMEOUT_MS / 1000
export const DAYTONA_READ_MAX_ATTEMPTS = 3
export const DAYTONA_READ_MAX_RETRY_DELAY_MS = 5_000
export const MAX_BUFFERED_FILE_BYTES = 2 * 1024 * 1024
export const FORWARD_PROXY_CREDENTIAL_DOMAIN = "sproutos:sandbox-forward-proxy:v1"

export type DaytonaConfig = {
  apiKey: string
  organizationId: string
  apiUrl?: string
  /** The region the sandbox is created in. Sandbox lifespan limits are configured per region. */
  target?: string
  /**
   * The snapshot every sandbox starts from: the agent runtime and toolchains.
   *
   * Deliberately not defaulted. A wrong snapshot does not fail — it produces a sandbox with no
   * agent in it, and the symptom is the chat silently doing nothing rather than an error.
   */
  snapshot: string
  /** Public HTTPS forward proxy Daytona must use for all sandbox web traffic. */
  forwardProxyUrl: string
  /** 32-byte base64 root used to derive a different proxy password for every sandbox. */
  forwardProxyRootKey: string
}

export function daytonaConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DaytonaConfig {
  const apiKey = env.DAYTONA_API_KEY
  if (apiKey === undefined || apiKey === "") {
    throw new Error(
      "DAYTONA_API_KEY is not set. Sandboxes are rented; without a key there is nowhere " +
        "for the coding agent to run, and no default is meaningful.",
    )
  }

  const organizationId = env.DAYTONA_ORGANIZATION_ID
  if (organizationId === undefined || organizationId === "") {
    throw new Error(
      "DAYTONA_ORGANIZATION_ID is not set. Daytona API keys are themselves organization-scoped; " +
        "this value makes the intended billed account explicit for snapshot operations.",
    )
  }

  const snapshot = env.SANDBOX_DAYTONA_SNAPSHOT
  if (snapshot === undefined || snapshot === "") {
    throw new Error(
      "SANDBOX_DAYTONA_SNAPSHOT is not set. It names the image carrying the agent runtime and the " +
        "desktop; falling back to a provider default would create a sandbox that starts cleanly, " +
        "has no agent in it, and reports no error.",
    )
  }

  const forwardProxyUrl = env.SANDBOX_FORWARD_PROXY_URL
  if (forwardProxyUrl === undefined || forwardProxyUrl === "") {
    throw new Error(
      "SANDBOX_FORWARD_PROXY_URL is not set. Daytona must send sandbox internet traffic through " +
        "the platform proxy so the sandbox cannot bypass lifecycle authorization.",
    )
  }
  validateForwardProxyUrl(forwardProxyUrl)

  const forwardProxyRootKey = env.SANDBOX_FORWARD_PROXY_ROOT_KEY
  if (forwardProxyRootKey === undefined || forwardProxyRootKey === "") {
    throw new Error(
      "SANDBOX_FORWARD_PROXY_ROOT_KEY is not set. It derives the per-sandbox credential used by " +
        "both Daytona creation and the router's forward-proxy listener.",
    )
  }
  decodeForwardProxyRootKey(forwardProxyRootKey)

  return {
    apiKey,
    organizationId,
    snapshot,
    forwardProxyUrl,
    forwardProxyRootKey,
    ...(env.SANDBOX_DAYTONA_API_URL ? { apiUrl: env.SANDBOX_DAYTONA_API_URL } : {}),
    ...(env.SANDBOX_DAYTONA_TARGET ? { target: env.SANDBOX_DAYTONA_TARGET } : {}),
  }
}

function validateForwardProxyUrl(value: string): URL {
  const url = new URL(value)
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(
      "SANDBOX_FORWARD_PROXY_URL must be an HTTPS origin with no credentials, path, query, or fragment",
    )
  }
  return url
}

function decodeForwardProxyRootKey(value: string): Buffer {
  const key = Buffer.from(value, "base64")
  if (key.length !== 32 || key.toString("base64") !== value) {
    throw new Error("SANDBOX_FORWARD_PROXY_ROOT_KEY must be exactly 32 bytes in canonical base64")
  }
  return key
}

/** Must agree with `lib/rust/sandbox-forward-proxy/fixtures/credentials.json`. */
export function sandboxForwardProxyPassword(rootKeyBase64: string, sandboxId: string): string {
  return createHmac("sha256", decodeForwardProxyRootKey(rootKeyBase64))
    .update(`${FORWARD_PROXY_CREDENTIAL_DOMAIN}\0${sandboxId.toLowerCase()}`, "utf8")
    .digest("base64url")
}

export function sandboxForwardProxyUrl(config: DaytonaConfig, sandboxId: string): string {
  const url = validateForwardProxyUrl(config.forwardProxyUrl)
  url.username = sandboxId.toLowerCase()
  url.password = sandboxForwardProxyPassword(config.forwardProxyRootKey, sandboxId)
  return url.toString()
}

/**
 * Sandboxes rented from Daytona Cloud.
 *
 * The client is built on first use rather than at module scope. A client constructed while the
 * module is imported opens a connection as a side effect of the import — commit `2249bad` records
 * that exact bug taking down the OpenAPI generator, whose process then never exited and timed out
 * at three minutes.
 */

/**
 * The exact parameters a create sends, as a pure function.
 *
 * Separated from {@link daytonaDriver} so the properties that matter — that the billed size agrees
 * with the snapshot's immutable size, that attribution is present, that the preview is not public,
 * and that the autostop backstop is never accidentally disabled — are checkable without a network
 * call or a mocked client.
 */
export function buildCreateParams(
  config: DaytonaConfig,
  input: CreateSandboxInput,
): CreateSandboxFromSnapshotParams {
  if (input.sandboxClass !== "container") {
    throw new Error(
      `Daytona sandbox class ${input.sandboxClass} is unsupported; only container sandboxes have ` +
        "a configured snapshot and execution path",
    )
  }

  const requested = input.resources
  if (
    requested.cpu !== SNAPSHOT_RESOURCES.cpu ||
    requested.memoryGib !== SNAPSHOT_RESOURCES.memoryGib ||
    requested.diskGib !== SNAPSHOT_RESOURCES.diskGib
  ) {
    throw new Error(
      `Daytona snapshot resources are fixed at ${SNAPSHOT_RESOURCES.cpu} CPU, ` +
        `${SNAPSHOT_RESOURCES.memoryGib} GiB memory and ${SNAPSHOT_RESOURCES.diskGib} GiB disk; ` +
        `the sandbox row requested ${requested.cpu}/${requested.memoryGib}/${requested.diskGib}`,
    )
  }

  return {
    // A retry must address the same provider object. The UUID is app-supplied and unique, so this
    // name is deterministic without leaking a repository or user name into Daytona's console.
    name: `sproutos-${input.sandboxId}`,
    snapshot: config.snapshot,
    // Daytona installs this create-time-only upstream as HTTP_PROXY/HTTPS_PROXY inside the
    // sandbox. The credential is unique to this sandbox and remains useful only while the router
    // sees the corresponding control-plane row in a live state.
    outboundProxyUrl: sandboxForwardProxyUrl(config, input.sandboxId),
    /*
    Attribution, and the reason `organizationId` is required rather than optional.

    `docs/findings/0011-the-platform-was-free.md`: the metering agent worked perfectly and
    attributed every workload to nobody, because the label it read was not the label the
    renderer wrote. There is no error state for billing nothing, so these keys are the ones
    `attributionLabels()` produces and nothing else.
    */
    labels: {
      "sproutos.dev/organization-id": input.organizationId,
      "sproutos.dev/project-id": input.projectId,
      "sproutos.dev/user-id": input.userId,
      "sproutos.dev/sandbox-id": input.sandboxId,
    },
    ...(input.env ? { envVars: input.env } : {}),
    /*
    Minutes, and rounded up rather than down: a zero here does not mean "immediately", it means
    **disabled**, so a sub-minute timeout would silently turn the provider's backstop off.
    */
    autoStopInterval: input.alwaysOn ? 0 : Math.max(1, Math.ceil(input.idleTimeoutS / 60)),
    /*
    Stopped Daytona containers still reserve and bill disk. Archiving preserves the filesystem,
    releases that quota, and is free; one minute keeps stop/start uncomplicated while bounding the
    otherwise indefinite stopped-disk charge. The control-plane row stays `stopped`, because start
    works for both stopped and archived provider states.
    */
    autoArchiveInterval: AUTO_ARCHIVE_AFTER_STOP_MINUTES,
    /*
    Do not set Daytona's domain or network allow-list fields. Sandboxes need the ordinary internet
    to install arbitrary customer dependencies and talk to arbitrary third-party APIs; an allow
    list would make those valid programs fail according to which vendor they happen to use.
    */
    // Never public. A preview is reached with a signed, short-lived URL; `public` would make a
    // customer's work-in-progress readable by anyone who guesses the sandbox id.
    public: false,
  }
}

export function daytonaDriver(config: DaytonaConfig): SandboxDriver {
  let client: Daytona | undefined
  const persistentSessions = new Map<string, Set<string>>()

  function sdk(): Daytona {
    client ??= new Daytona({
      apiKey: config.apiKey,
      organizationId: config.organizationId,
      ...(config.apiUrl ? { apiUrl: config.apiUrl } : {}),
      ...(config.target ? { target: config.target } : {}),
      requestTimeoutMs: DAYTONA_REQUEST_TIMEOUT_MS,
    })
    return client
  }

  /** Every provider call goes through here, so a fault is never reported as a customer error. */
  async function call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (cause) {
      if (isNotFound(cause)) throw new SandboxNotFoundError("unknown")
      throw new SandboxUnavailableError(PROVIDER, cause)
    }
  }

  async function get(externalId: string): Promise<Sandbox> {
    try {
      return await retryIdempotentDaytonaRead(() => sdk().get(externalId))
    } catch (cause) {
      if (isNotFound(cause)) throw new SandboxNotFoundError(externalId)
      throw new SandboxUnavailableError(PROVIDER, cause)
    }
  }

  async function create(input: CreateSandboxInput): Promise<CreatedSandbox> {
    const params = buildCreateParams(config, input)
    const matches = async (): Promise<Sandbox[]> =>
      await retryIdempotentDaytonaRead(async () => {
        const found: Sandbox[] = []
        for await (const sandbox of sdk().list({
          labels: { "sproutos.dev/sandbox-id": input.sandboxId },
        })) {
          found.push(sandbox)
        }
        if (found.length > 1) {
          throw new Error(
            `Daytona has ${found.length} sandboxes labelled for ${input.sandboxId}; refusing to ` +
              "choose one while another may still be billing",
          )
        }
        return found
      })

    const [existing] = await call(matches)
    if (existing) return { externalId: existing.id }

    try {
      const sandbox = await call(() => sdk().create(params))
      return { externalId: sandbox.id }
    } catch (cause) {
      // A timeout or name conflict can mean create succeeded and only its response was lost. The
      // label is the idempotency key; query it once before allowing the job runner to retry create.
      const [recovered] = await call(matches)
      if (recovered) return { externalId: recovered.id }
      throw cause
    }
  }

  async function exec(externalId: string, argv: string[], timeoutMs: number): Promise<ExecResult> {
    const sandbox = await get(externalId)
    // Quoted, never joined. `argv.ts` is the whole argument for why.
    const command = quoteArgv(argv)
    /*
      A session rather than `process.executeCommand`, because that returns `{exitCode, result}` and
      `result` is stdout and stderr interleaved — the type has no stderr at all. Our contract
      promises the two separately (`sandboxes.serializer.ts`), and a `stderr` that is structurally
      always empty is the `sandbox.runtime_class` mistake again: a field whose name promises
      something the value never carries. `executeSessionCommand` returns them apart.
    */
    const sessionId = `exec-${crypto.randomUUID()}`
    return await call(async () => {
      await sandbox.process.createSession(sessionId)
      try {
        const response = await sandbox.process.executeSessionCommand(
          sessionId,
          { command, runAsync: false },
          Math.ceil(timeoutMs / 1000),
        )
        return {
          stdout: response.stdout ?? "",
          stderr: response.stderr ?? "",
          // Absent means the command did not report one. Reporting 0 would call a crash a success.
          exitCode: response.exitCode ?? -1,
        }
      } finally {
        // Sessions outlive the command and are billed with the sandbox; a leaked one per exec adds
        // up quietly. Best effort — a failure here must not replace the command's own result.
        await sandbox.process.deleteSession(sessionId).catch(() => {})
      }
    })
  }

  /**
   * Run a command and stream its output while it runs.
   *
   * `runAsync: true` is the whole difference from `exec`. The synchronous form returns when the
   * command is over, which for an agent turn means several minutes of nothing followed by
   * everything at once. Asynchronous returns a command id immediately, and the SDK will call back
   * with log chunks as they are produced.
   *
   * The exit code is fetched afterwards, because the streaming call does not carry one — and a
   * caller that assumed success from "the stream ended" would treat a crashed agent as a finished
   * one.
   */
  async function execStream(
    externalId: string,
    argv: string[],
    timeoutMs: number,
    onStdout: (chunk: string) => void,
    onStderr: (chunk: string) => void,
  ): Promise<ExecResult> {
    const sandbox = await get(externalId)
    const command = quoteArgv(argv)
    const sessionId = `stream-${crypto.randomUUID()}`

    return await call(async () => {
      let keepSession = false
      await sandbox.process.createSession(sessionId)
      try {
        const started = await sandbox.process.executeSessionCommand(sessionId, {
          command,
          runAsync: true,
        })
        const commandId = started.cmdId
        if (commandId === undefined) {
          // Without an id there is nothing to follow. Falling back to the synchronous form would be
          // worse than saying so: it would look like it worked and stream nothing.
          throw new Error("the sandbox provider started a command with no id to follow")
        }

        let stdout = ""
        let stderr = ""
        const collecting = sandbox.process.getSessionCommandLogs(
          sessionId,
          commandId,
          (chunk) => {
            stdout += chunk
            onStdout(chunk)
          },
          (chunk) => {
            stderr += chunk
            onStderr(chunk)
          },
        )

        /*
          A timeout around the follow, not inside it.

          `getSessionCommandLogs` resolves when the command ends; it has no deadline of its own, so
          a hung agent would hold this request open until something else gave up. Racing it against
          a timer is what makes `timeoutMs` mean anything.
        */
        let timer: NodeJS.Timeout | undefined
        const deadline = new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => {
            resolve("timeout")
          }, timeoutMs)
        })
        const outcome = await Promise.race([collecting.then(() => "done" as const), deadline])
        if (timer !== undefined) clearTimeout(timer)

        if (outcome === "timeout") {
          return { stdout, stderr, exitCode: -1 }
        }

        const finished = await sandbox.process.getSessionCommand(sessionId, commandId)
        /*
          Keep the session after a completed agent turn.

          Daytona ties descendants to the process session: deleting it kills even a `nohup` dev
          server the agent intentionally left behind. A preview that disappears when the answer
          finishes is not a preview. Sessions are tracked and removed when the sandbox stops or is
          destroyed, which is the lifecycle boundary that should kill those processes.
        */
        const exitCode = finished.exitCode ?? -1
        keepSession = exitCode === 0
        return { stdout, stderr, exitCode }
      } finally {
        if (keepSession) {
          const sessions = persistentSessions.get(externalId) ?? new Set<string>()
          sessions.add(sessionId)
          persistentSessions.set(externalId, sessions)
        } else {
          await sandbox.process.deleteSession(sessionId).catch(() => {})
        }
      }
    })
  }

  async function deletePersistentSessions(externalId: string, sandbox: Sandbox): Promise<void> {
    const sessions = persistentSessions.get(externalId)
    if (sessions === undefined) return
    persistentSessions.delete(externalId)
    await Promise.all(
      [...sessions].map((sessionId) => sandbox.process.deleteSession(sessionId).catch(() => {})),
    )
  }

  async function readFile(externalId: string, path: string): Promise<string> {
    const sandbox = await get(externalId)
    const details = await call(() => sandbox.fs.getFileDetails(path))
    if (details.size > MAX_BUFFERED_FILE_BYTES) {
      throw new Error(
        `Refusing to buffer ${details.size} bytes from ${path}; the file API limit is ` +
          `${MAX_BUFFERED_FILE_BYTES} bytes`,
      )
    }
    const buffer = await call(() => sandbox.fs.downloadFile(path))
    return buffer.toString("utf8")
  }

  async function writeFile(externalId: string, path: string, content: string): Promise<void> {
    const sandbox = await get(externalId)
    await call(() => sandbox.fs.uploadFile(Buffer.from(content, "utf8"), path))
  }

  async function tree(externalId: string, path?: string): Promise<TreeEntry[]> {
    const sandbox = await get(externalId)
    const entries = await call(() => sandbox.fs.listFiles(path ?? WORKSPACE_DIR))
    return entries.map((entry) => ({
      path: entry.name,
      kind: entry.isDir ? "directory" : "file",
      sizeBytes: entry.isDir ? null : (entry.size ?? null),
    }))
  }

  async function previewUrl(
    externalId: string,
    port: number,
    expiresInS: number,
  ): Promise<PreviewLink> {
    const sandbox = await get(externalId)
    /*
      Signed, not header-authenticated.

      `getPreviewLink` hands back a token meant for an `x-daytona-preview-token` header, which is
      fine for a fetch and impossible for the `iframe` a person actually looks at. The other way to
      make an iframe work is `public: true`, which removes authentication from the preview
      altogether. So the token goes in the URL, minted per request and short-lived.
    */
    const signed = await call(() => sandbox.getSignedPreviewUrl(port, expiresInS))
    // The provider returns no expiry, so it is computed from what we asked for. Deliberately from
    // the same number, so a caller cannot be told a link lasts longer than it does.
    return { url: signed.url, expiresAt: new Date(Date.now() + expiresInS * 1000) }
  }

  return {
    provider: PROVIDER,
    workspaceDir: WORKSPACE_DIR,
    create,
    state: async (externalId) => {
      const sandbox = await get(externalId)
      await call(() => retryIdempotentDaytonaRead(() => sandbox.refreshData()))
      return sandbox.state ?? "unknown"
    },
    start: async (externalId) => {
      const sandbox = await get(externalId)
      await call(() => sandbox.start())
    },
    stop: async (externalId) => {
      const sandbox = await get(externalId)
      await deletePersistentSessions(externalId, sandbox)
      await call(() => sandbox.stop())
    },
    destroy: async (externalId) => {
      /*
        A sandbox that is already gone is a successful destroy.

        Teardown and the reaper both call this, and both can run twice — a job retried after its
        lease expired sees the same row. Treating "not found" as an error there turns a completed
        deletion into a job that fails forever, and the dead-letter queue fills with sandboxes that
        no longer exist.
      */
      try {
        const sandbox = await get(externalId)
        await deletePersistentSessions(externalId, sandbox)
        await call(() => deleteDaytonaSandboxAndWait(sandbox))
      } catch (error) {
        if (error instanceof SandboxNotFoundError) return
        throw error
      }
    },
    cloneRepository: async (externalId, input) => {
      const sandbox = await get(externalId)
      await call(() =>
        sandbox.git.clone(
          input.url,
          input.path,
          input.branch,
          undefined,
          input.password === "" ? undefined : input.username,
          input.password === "" ? undefined : input.password,
          false,
          input.depth,
        ),
      )
    },
    exec,
    execStream,
    readFile,
    writeFile,
    tree,
    previewUrl,
    touch: async (externalId) => {
      const sandbox = await get(externalId)
      await call(() => sandbox.refreshActivity())
    },
  }
}

let processDriver: SandboxDriver | undefined
let processDriverConfig: string | undefined

/**
 * Daytona is the production sandbox. There is intentionally no local fallback.
 *
 * One driver per process is also one Daytona SDK event connection per process. Constructing a
 * driver for every route call leaks a persistent provider socket even after the operation ends.
 */
export function sandboxDriverFromEnv(env: NodeJS.ProcessEnv = process.env): SandboxDriver {
  const config = daytonaConfigFromEnv(env)
  const key = JSON.stringify(config)
  if (processDriver === undefined) {
    processDriver = daytonaDriver(config)
    processDriverConfig = key
  } else if (processDriverConfig !== key) {
    throw new Error("Daytona configuration changed after the process driver was initialized")
  }
  return processDriver
}

/** A 404 from the provider, however its client happens to have wrapped it. */
function isNotFound(cause: unknown): boolean {
  return sandboxProviderHttpDetails(cause).statusCode === 404
}

/** Delete is successful only after Daytona confirms the sandbox reached `destroyed`. */
export async function deleteDaytonaSandboxAndWait(sandbox: Pick<Sandbox, "delete">): Promise<void> {
  await sandbox.delete(DAYTONA_DELETE_TIMEOUT_SECONDS, true)
}

/**
 * Retry only idempotent Daytona reads when the provider asks us to slow down.
 *
 * Create, start, stop, delete, writes, commands and activity touches deliberately do not use this
 * helper: their response can be lost after the mutation happened, so blindly repeating them can
 * duplicate work. Create retains its existing label-based reconciliation instead.
 */
export async function retryIdempotentDaytonaRead<T>(
  read: () => Promise<T>,
  sleep: (delayMs: number) => Promise<void> = delay,
): Promise<T> {
  async function attemptRead(attempt: number): Promise<T> {
    try {
      return await read()
    } catch (cause) {
      const details = sandboxProviderHttpDetails(cause)
      if (details.statusCode !== 429 || attempt >= DAYTONA_READ_MAX_ATTEMPTS) throw cause
      await sleep(daytonaRetryDelayMs(details.retryAfter, attempt))
      return await attemptRead(attempt + 1)
    }
  }

  return await attemptRead(1)
}

function daytonaRetryDelayMs(retryAfter: string | undefined, attempt: number): number {
  let requestedDelay: number | undefined
  if (retryAfter !== undefined) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) {
      requestedDelay = seconds * 1_000
    } else {
      const date = Date.parse(retryAfter)
      if (Number.isFinite(date)) requestedDelay = Math.max(0, date - Date.now())
    }
  }
  return Math.min(requestedDelay ?? 250 * 2 ** (attempt - 1), DAYTONA_READ_MAX_RETRY_DELAY_MS)
}

async function delay(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
}
