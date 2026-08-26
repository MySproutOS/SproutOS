import {
  Daytona,
  type CreateSandboxFromSnapshotParams,
  type Resources,
  type Sandbox,
} from "@daytonaio/sdk"
import { quoteArgv } from "./argv"
import { EGRESS_ALLOW_LIST } from "./egress"
import {
  SandboxNotFoundError,
  SandboxUnavailableError,
  type CreateSandboxInput,
  type CreatedSandbox,
  type ExecResult,
  type PreviewLink,
  type SandboxDriver,
  type TreeEntry,
} from "./types"

export const PROVIDER = "daytona"

/**
 * The port the desktop's browser-facing VNC bridge listens on inside the sandbox.
 *
 * `computerUse.start()` brings up Xvfb, a window manager, an X11 VNC server and noVNC; noVNC is the
 * only one of the four a browser can talk to, and it is reached through an ordinary preview link
 * like any other port. Naming it here keeps the number out of three call sites.
 */
export const NOVNC_PORT = 6080

/** Where the customer's repository is checked out, and the only path that survives a stop. */
export const WORKSPACE_DIR = "/home/daytona/workspace"

export type DaytonaConfig = {
  apiKey: string
  apiUrl?: string
  /** The region the sandbox is created in. Sandbox lifespan limits are configured per region. */
  target?: string
  /**
   * The snapshot every sandbox starts from: the agent runtime, the toolchains, the desktop.
   *
   * Deliberately not defaulted. A wrong snapshot does not fail — it produces a sandbox with no
   * agent in it, and the symptom is the chat silently doing nothing rather than an error.
   */
  snapshot: string
}

export function daytonaConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DaytonaConfig {
  const apiKey = env.SANDBOX_DAYTONA_API_KEY
  if (apiKey === undefined || apiKey === "") {
    throw new Error(
      "SANDBOX_DAYTONA_API_KEY is not set. Sandboxes are rented; without a key there is nowhere " +
        "for the coding agent to run, and no default is meaningful.",
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

  return {
    apiKey,
    snapshot,
    ...(env.SANDBOX_DAYTONA_API_URL ? { apiUrl: env.SANDBOX_DAYTONA_API_URL } : {}),
    ...(env.SANDBOX_DAYTONA_TARGET ? { target: env.SANDBOX_DAYTONA_TARGET } : {}),
  }
}

/**
 * `create` accepts resources alongside a snapshot; its published type does not.
 *
 * `Daytona.create` reads them with `if ('resources' in params)` and forwards `cpu`, `memory` and
 * `disk` to the REST call, which takes them as flat fields regardless of whether a snapshot was
 * named — but the SDK declares `resources` only on the from-image overload. Widening it here is
 * narrower than casting the whole parameter object to `any`: if the runtime behaviour ever changes
 * to match the declaration, sandboxes come back at the provider's default size, which
 * `daytona.test.ts` asserts against.
 */
type CreateWithResources = CreateSandboxFromSnapshotParams & { resources?: Resources }

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
 * Separated from {@link daytonaDriver} so the properties that matter — that resources survive
 * alongside a snapshot, that attribution is present, that the preview is not public, that the
 * autostop backstop is never accidentally disabled — are checkable without a network call or a
 * mocked client. Every one of them fails silently in production: a sandbox still starts.
 */
export function buildCreateParams(
  config: DaytonaConfig,
  input: CreateSandboxInput,
): CreateWithResources {
  return {
    snapshot: config.snapshot,
    resources: {
      cpu: input.resources.cpu,
      memory: input.resources.memoryGib,
      disk: input.resources.diskGib,
    },
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
    autoStopInterval: Math.max(1, Math.ceil(input.idleTimeoutS / 60)),
    /*
    Egress. See `egress.ts` — this is finding 0009's network policy written as an allow list,
    and the property it exists for is that 169.254.169.254 is not in it.
    */
    networkAllowList: EGRESS_ALLOW_LIST,
    // Never public. A preview is reached with a signed, short-lived URL; `public` would make a
    // customer's work-in-progress readable by anyone who guesses the sandbox id.
    public: false,
  }
}

export function daytonaDriver(config: DaytonaConfig): SandboxDriver {
  let client: Daytona | undefined

  function sdk(): Daytona {
    client ??= new Daytona({
      apiKey: config.apiKey,
      ...(config.apiUrl ? { apiUrl: config.apiUrl } : {}),
      ...(config.target ? { target: config.target } : {}),
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
      return await sdk().get(externalId)
    } catch (cause) {
      if (isNotFound(cause)) throw new SandboxNotFoundError(externalId)
      throw new SandboxUnavailableError(PROVIDER, cause)
    }
  }

  async function create(input: CreateSandboxInput): Promise<CreatedSandbox> {
    const sandbox = await call(() => sdk().create(buildCreateParams(config, input)))
    return { externalId: sandbox.id }
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
        return { stdout, stderr, exitCode: finished.exitCode ?? -1 }
      } finally {
        await sandbox.process.deleteSession(sessionId).catch(() => {})
      }
    })
  }

  async function readFile(externalId: string, path: string): Promise<string> {
    const sandbox = await get(externalId)
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
    create,
    start: async (externalId) => {
      const sandbox = await get(externalId)
      await call(() => sandbox.start())
    },
    stop: async (externalId) => {
      const sandbox = await get(externalId)
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
        await call(() => sandbox.delete())
      } catch (error) {
        if (error instanceof SandboxNotFoundError) return
        throw error
      }
    },
    exec,
    execStream,
    readFile,
    writeFile,
    tree,
    previewUrl,
    startDisplay: async (externalId) => {
      const sandbox = await get(externalId)
      await call(() => sandbox.computerUse.start())
    },
    displayUrl: async (externalId, expiresInS) => previewUrl(externalId, NOVNC_PORT, expiresInS),
    touch: async (externalId) => {
      const sandbox = await get(externalId)
      await call(() => sandbox.refreshActivity())
    },
  }
}

/** A 404 from the provider, however its client happens to have wrapped it. */
function isNotFound(cause: unknown): boolean {
  const status = (cause as { response?: { status?: number }; status?: number } | null)?.response
    ?.status
  return status === 404 || (cause as { status?: number } | null)?.status === 404
}
