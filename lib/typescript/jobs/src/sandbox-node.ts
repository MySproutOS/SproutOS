import { runInSandbox, sandboxRuntimeClass, type SandboxResult } from "@lib/sandbox"

/**
 * Executing the workflow nodes that carry customer-supplied destinations or customer-supplied code.
 *
 * These used to be refused outright — recorded `skipped`, run marked `failed` — because the only
 * place to run them was the job worker, and the job worker holds the control-plane database URL,
 * the envelope KMS key, the GitHub App credentials and a Kubernetes service-account token. Fetching
 * a URL a customer typed from *there* reaches the API server, every tenant's database, and
 * `169.254.169.254`.
 *
 * They run in a sandbox now: a Job in the tenant's own namespace, where
 * `deploy/tenant/network-policy.yaml` denies by default and excludes every private range from
 * egress, with no service-account token, no root, no capabilities and a hard deadline. On a cluster
 * with a Kata runtime class there is a VM under it as well; on one without, there is not, and that
 * is the honest state rather than a claim.
 */

/** The image a node runs in. Small, and holds exactly the one tool the node needs. */
const IMAGES = {
  http: "curlimages/curl:8.11.1",
  code: "node:24-alpine",
} as const

export class UnsupportedNodeError extends Error {
  override readonly name = "UnsupportedNodeError"

  constructor(readonly nodeType: string) {
    super(`${nodeType} has no sandbox runner`)
  }
}

/** A DNS label naming one node's run. Bounded because Kubernetes rejects a name over 63 characters. */
export function sandboxName(runId: string, nodeId: string): string {
  const suffix = nodeId
    .toLowerCase()
    .replaceAll(/[^a-z0-9]/g, "-")
    .slice(0, 20)
  return `wf-${runId.replaceAll("-", "").slice(-16)}-${suffix}`.slice(0, 63).replace(/-+$/, "")
}

/**
 * The URL an `action.http` node fetches.
 *
 * Validated here as well as blocked by the NetworkPolicy. Not redundant: the policy is a runtime
 * object somebody can delete or a CNI can decline to enforce — `kind`'s does exactly that — and a
 * scheme check costs nothing. `file:` and `gopher:` are the ones that turn a fetch into a read.
 */
export function assertFetchableUrl(raw: unknown): string {
  if (typeof raw !== "string" || raw === "") throw new Error("action.http needs a url")
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`action.http url is not a URL: ${JSON.stringify(raw.slice(0, 80))}`)
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`action.http refuses the ${url.protocol} scheme`)
  }
  return url.toString()
}

export type NodeRun = {
  namespace: string
  runId: string
  nodeId: string
  nodeType: string
  config: Record<string, unknown>
  timeoutSeconds?: number
}

/** Run one node in a sandbox and return what it said. */
export async function runNodeInSandbox(input: NodeRun): Promise<SandboxResult> {
  const common = {
    namespace: input.namespace,
    name: sandboxName(input.runId, input.nodeId),
    ...(input.timeoutSeconds === undefined ? {} : { timeoutSeconds: input.timeoutSeconds }),
    ...(sandboxRuntimeClass() === undefined ? {} : { runtimeClassName: sandboxRuntimeClass() }),
  }

  if (input.nodeType === "action.http") {
    const url = assertFetchableUrl(input.config.url)
    const method = typeof input.config.method === "string" ? input.config.method : "GET"

    return await runInSandbox({
      ...common,
      image: IMAGES.http,
      /*
        The URL is an argument, never part of a shell string, so nothing in it can become a second
        command. `--fail-with-body` so an HTTP error is a non-zero exit *and* keeps the body, which
        is the half a workflow author actually wants to see.
      */
      command: [
        "curl",
        "--silent",
        "--show-error",
        "--fail-with-body",
        "--max-time",
        "30",
        "--request",
        method,
        url,
      ],
    })
  }

  if (input.nodeType === "action.code") {
    const source = typeof input.config.source === "string" ? input.config.source : ""
    if (source === "") throw new Error("action.code needs source")

    return await runInSandbox({
      ...common,
      image: IMAGES.code,
      /*
        Passed with `-e`, as one argument. The alternative — writing it to a file with `sh -c` — puts
        customer source through a shell before Node ever sees it, and the quoting that makes that
        safe is the quoting people get wrong.
      */
      command: ["node", "-e", source],
      // Node needs somewhere to write; the root filesystem is read-only and `/tmp` is the emptyDir.
      env: { HOME: "/tmp", NODE_OPTIONS: "--max-old-space-size=192" },
    })
  }

  throw new UnsupportedNodeError(input.nodeType)
}
