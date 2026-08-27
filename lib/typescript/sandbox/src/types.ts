/**
 * One interface for a sandbox, whoever is running it.
 *
 * A sandbox is where the coding agent lives: a checkout of the customer's repository, a shell, a
 * dev server on a port somebody can look at, and — for an Android project — an emulator with a
 * screen two parties watch at once. ADR 0026 made Lambda the only place customer code runs, and
 * none of that fits a fifteen-minute invocation, so the compute is rented.
 *
 * The provider is Daytona today. This interface exists because their open-source repository stopped
 * being maintained in June 2026 with development moved to a private codebase — we are buying the
 * hosted product, not the project, and the seam is what makes that survivable. It is deliberately
 * the same shape as {@link ../../services/src/types.ts | ServiceDriver}, which already carries
 * every backend service a customer can provision behind one set of verbs.
 *
 * What is *not* behind this interface is as important as what is. The control plane keeps the
 * `sandbox` row, the credit hold, the idle timer, the RBAC check and the customer's LLM credential.
 * The provider holds a container and nothing else.
 */

/**
 * What kind of machine the sandbox is.
 *
 * Not the full set a provider offers — Daytona's own `SandboxClass` also has `linux-vm` and
 * `windows` — but the set *this platform* supports, which is a code-level fact a type checker can
 * see. The database deliberately does not enumerate these: `sandbox_class_check` tests the shape,
 * because `sandbox_runtime_class_check` was wrong three times by enumerating a set it did not own,
 * and each time the value being refused was the true one.
 */
export const SANDBOX_CLASSES = ["container", "android"] as const

export type SandboxClass = (typeof SANDBOX_CLASSES)[number]

/** What we asked the provider for, and therefore what `sandbox.meter` bills. */
export type SandboxResources = {
  cpu: number
  memoryGib: number
  diskGib: number
}

export type CreateSandboxInput = {
  /**
   * Our id for the sandbox, which the row already has.
   *
   * Passed to the provider as a label so a sandbox found on their side can be traced back here.
   * An orphan nobody can attribute is an orphan nobody stops paying for.
   */
  sandboxId: string
  /**
   * Required, and not for convenience.
   *
   * `docs/findings/0011-the-platform-was-free.md` is the whole platform metering to nobody while
   * every check passed, because there is no error state for billing nothing. Making this
   * non-optional means the compiler enumerates the paths that would have been free.
   */
  organizationId: string
  projectId: string
  userId: string
  sandboxClass: SandboxClass
  resources: SandboxResources
  /** Long-running environments deliberately disable Daytona's idle auto-stop. */
  alwaysOn: boolean
  /** Minutes of inactivity after which the provider stops it. Our reaper is authoritative; this is
   *  the backstop for when a job never runs. */
  idleTimeoutS: number
  /** Injected into the sandbox's environment. Never the customer's raw LLM credential — see
   *  the `ANTHROPIC_BASE_URL` pass-through in the plan. */
  env?: Record<string, string>
}

export type CreatedSandbox = {
  /** The provider's id. Stored in `sandbox.external_id`, unique per provider. */
  externalId: string
}

export type ExecResult = {
  stdout: string
  stderr: string
  exitCode: number
}

export type TreeEntry = {
  path: string
  kind: "file" | "directory"
  sizeBytes: number | null
}

/**
 * A URL somebody can open, and when it stops working.
 *
 * Signed rather than header-authenticated. A provider preview token is normally sent in a header,
 * which is fine for `curl` and impossible for an `iframe` — and the alternative the provider offers
 * is marking the sandbox public, which makes a customer's work-in-progress world-readable. So the
 * token is embedded, short-lived, and minted per request on the server.
 */
export type PreviewLink = {
  url: string
  expiresAt: Date
}

export type SandboxDriver = {
  /** Matches `sandbox.provider`. */
  provider: string
  /** The persistent checkout root inside this provider's sandbox. */
  workspaceDir: string
  create: (input: CreateSandboxInput) => Promise<CreatedSandbox>
  /** Read the provider's current state rather than trusting the control-plane row. */
  state: (externalId: string) => Promise<string>
  start: (externalId: string) => Promise<void>
  stop: (externalId: string) => Promise<void>
  destroy: (externalId: string) => Promise<void>
  /** Clone with credentials carried by the provider API, never embedded in a sandbox command. */
  cloneRepository: (
    externalId: string,
    input: {
      url: string
      path: string
      branch: string
      username: string
      password: string
      depth?: number
    },
  ) => Promise<void>
  /**
   * Run a command.
   *
   * `argv`, never a command line. `apps/internal-api/src/utils/require-array.ts` exists because
   * TypeBox's `Value.Convert` wrapped the string `"ls -la"` into `["ls -la"]` and returned 200 for
   * a request nobody made; the array is the shape that cannot be silently coerced into.
   */
  exec: (externalId: string, argv: string[], timeoutMs: number) => Promise<ExecResult>
  /**
   * Run a command and watch its output arrive.
   *
   * Separate from `exec` rather than replacing it, because the two answer different questions. A
   * build step is a result: you want the exit code and you do not care what it printed until it is
   * over. An agent turn is a *performance* — it runs for minutes and the whole value of watching it
   * is seeing the tool calls as they happen. `exec` on an agent turn is a spinner for five minutes
   * followed by a wall of text.
   *
   * `onStdout` receives arbitrary chunks, split wherever the transport split them. Callers that
   * parse line-oriented output must buffer to line boundaries themselves — a chunk can end
   * mid-line, and code that assumes otherwise works on every short output and fails on real ones.
   */
  execStream: (
    externalId: string,
    argv: string[],
    timeoutMs: number,
    onStdout: (chunk: string) => void,
    onStderr: (chunk: string) => void,
  ) => Promise<ExecResult>
  readFile: (externalId: string, path: string) => Promise<string>
  writeFile: (externalId: string, path: string, content: string) => Promise<void>
  tree: (externalId: string, path?: string) => Promise<TreeEntry[]>
  previewUrl: (externalId: string, port: number, expiresInS: number) => Promise<PreviewLink>
  /** Tell the provider it is still in use, so its own autostop does not fire under an active user. */
  touch: (externalId: string) => Promise<void>
}

/** The provider could not be reached or refused. An operational fault, never a customer error. */
export class SandboxUnavailableError extends Error {
  override readonly name = "SandboxUnavailableError"

  /** HTTP status returned by the provider, when the SDK exposed one. */
  readonly statusCode: number | undefined
  /** Provider response headers copied into a stable, serializable shape. */
  readonly headers: Readonly<Record<string, string>> | undefined
  /** The provider's Retry-After value, retained separately for job scheduling and diagnostics. */
  readonly retryAfter: string | undefined

  constructor(
    readonly provider: string,
    override readonly cause?: unknown,
  ) {
    super(`The ${provider} sandbox provider is unavailable`)
    const details = sandboxProviderHttpDetails(cause)
    this.statusCode = details.statusCode
    this.headers = details.headers
    this.retryAfter = details.retryAfter
  }
}

export type SandboxProviderHttpDetails = {
  statusCode?: number
  headers?: Readonly<Record<string, string>>
  retryAfter?: string
}

/**
 * Extract HTTP details from both DaytonaError and the underlying Axios-shaped error.
 *
 * DaytonaError uses `statusCode` and `headers`; an error raised before the SDK wraps the response
 * can instead expose `response.status` and `response.headers`. Keeping this structural avoids
 * coupling the provider-independent error type to Daytona or Axios classes.
 */
export function sandboxProviderHttpDetails(cause: unknown): SandboxProviderHttpDetails {
  const value = cause as {
    statusCode?: unknown
    status?: unknown
    headers?: unknown
    response?: { status?: unknown; headers?: unknown }
  } | null
  const rawStatus = value?.statusCode ?? value?.response?.status ?? value?.status
  const statusCode = typeof rawStatus === "number" ? rawStatus : undefined
  const headers = normalizeProviderHeaders(value?.headers ?? value?.response?.headers)
  const retryHeaders = Object.entries(headers ?? {})
  const retryAfter =
    retryHeaders.find(([name]) => name.toLowerCase() === "retry-after")?.[1] ??
    retryHeaders.find(([name]) => name.toLowerCase().startsWith("retry-after-"))?.[1]

  return {
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(headers === undefined ? {} : { headers }),
    ...(retryAfter === undefined ? {} : { retryAfter }),
  }
}

function normalizeProviderHeaders(
  rawHeaders: unknown,
): Readonly<Record<string, string>> | undefined {
  if (rawHeaders === null || rawHeaders === undefined || typeof rawHeaders !== "object") {
    return undefined
  }

  const toJSON = (rawHeaders as { toJSON?: unknown }).toJSON
  const source = typeof toJSON === "function" ? (toJSON.call(rawHeaders) as unknown) : rawHeaders
  if (source === null || typeof source !== "object") return undefined

  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(source)) {
    if (value === null || value === undefined) continue
    headers[name] = Array.isArray(value) ? value.map(String).join(", ") : String(value)
  }
  return Object.keys(headers).length === 0 ? undefined : headers
}

/** The provider has no sandbox by that id — it was destroyed, or never created. */
export class SandboxNotFoundError extends Error {
  override readonly name = "SandboxNotFoundError"

  constructor(readonly externalId: string) {
    super(`Sandbox ${externalId} does not exist at its provider`)
  }
}
