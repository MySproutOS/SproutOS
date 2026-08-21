import { readFileSync } from "node:fs"
import { Agent, request as httpsRequest } from "node:https"

/**
 * Just enough Kubernetes API to create and read a Knative Service.
 *
 * Not `@kubernetes/client-node`. The whole surface needed here is two HTTP calls against a JSON
 * API, and the client library brings a kubeconfig parser, an exec-credential plugin runner and a
 * websocket stack to provide them. This repository already vendors its OAuth client and its crypto
 * helpers for the same reason.
 *
 * Reads its credentials from the projected service-account token rather than a kubeconfig: the
 * control plane runs as a pod, and the token is rotated in place by the kubelet — so it is read on
 * every request rather than cached, or the client keeps presenting an expired one after roughly an
 * hour.
 */
const SERVICE_ACCOUNT = "/var/run/secrets/kubernetes.io/serviceaccount"

export type KubeConfig = {
  /** e.g. `https://10.96.0.1:443`. */
  server: string
  /** Omitted when the endpoint needs no credential, as with `kubectl proxy` in a test. */
  token?: () => string
  /** PEM. Omitted for a plain-HTTP endpoint. */
  certificateAuthority?: string
}

export class KubeError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    message: string,
  ) {
    super(message)
    this.name = "KubeError"
  }
}

/**
 * The configuration a pod running inside the cluster gets for free.
 *
 * Throws rather than falling back to anything: a control plane that silently talked to the wrong
 * API server would create tenant workloads somewhere nobody is looking.
 */
export function inClusterConfig(): KubeConfig {
  const host = process.env.KUBERNETES_SERVICE_HOST
  const port = process.env.KUBERNETES_SERVICE_PORT

  if (host === undefined || port === undefined) {
    throw new Error(
      "KUBERNETES_SERVICE_HOST/PORT are unset; this is not running inside a cluster and there is no fallback",
    )
  }

  return {
    server: `https://${host}:${port}`,
    // A function, not a value: the kubelet rewrites this file when the token is rotated, and a
    // process that read it once keeps sending an expired credential.
    token: () => readFileSync(`${SERVICE_ACCOUNT}/token`, "utf8").trim(),
    certificateAuthority: readFileSync(`${SERVICE_ACCOUNT}/ca.crt`, "utf8"),
  }
}

export function createKubeClient(config: KubeConfig) {
  /*
    The cluster's CA, actually used.

    `inClusterConfig` has always read `ca.crt` into `certificateAuthority` and this client has
    always ignored it, so every request from inside a pod failed with
    `unable to verify the first certificate` — the API server presents a certificate signed by the
    cluster's own CA, which is not in Node's default trust store and never will be. Nothing had
    noticed because nothing had ever called this from a pod: the deploy and build handlers had no
    RBAC to succeed with either, so the first failure they would have hit was a different one.

    `node:https` rather than `fetch`, because Node exposes no supported way to give `fetch` a CA:
    its `undici` is bundled and not exported, and the alternatives are a new dependency or
    `NODE_EXTRA_CA_CERTS`, which is process-global — the cluster's CA has no business being able to
    vouch for github.com.
  */
  const agent =
    config.certificateAuthority === undefined
      ? undefined
      : new Agent({ ca: config.certificateAuthority, keepAlive: true })

  async function request<T>(method: string, path: string, body?: unknown, contentType?: string) {
    const headers: Record<string, string> = { Accept: "application/json" }
    if (config.token !== undefined) headers.Authorization = `Bearer ${config.token()}`
    if (body !== undefined) headers["Content-Type"] = contentType ?? "application/json"

    const { status, text } = await send(
      `${config.server}${path}`,
      method,
      headers,
      body === undefined ? undefined : JSON.stringify(body),
      agent,
    )
    if (status < 200 || status >= 300) throw new KubeError(status, path, text.slice(0, 500))

    return JSON.parse(text) as T
  }

  /**
   * Server-side apply.
   *
   * `PATCH` with `application/apply-patch+yaml` rather than create-then-update, because a redeploy
   * of an existing project has to be an update and a first deploy has to be a create, and deciding
   * which by reading first is a race with every other actor in the cluster.
   *
   * `fieldManager` is what makes it safe to run repeatedly: the API server records which fields
   * this manager owns, so a field the platform stops setting is removed rather than left behind by
   * whatever set it last. `force` resolves conflicts in our favour — a human who edited a tenant's
   * Service by hand should not be able to pin it.
   */
  async function apply<T>(path: string, object: unknown): Promise<T> {
    return await request<T>(
      "PATCH",
      `${path}?fieldManager=sproutos-control-plane&force=true`,
      object,
      "application/apply-patch+yaml",
    )
  }

  async function get<T>(path: string): Promise<T | undefined> {
    try {
      return await request<T>("GET", path)
    } catch (error) {
      if (error instanceof KubeError && error.status === 404) return undefined
      throw error
    }
  }

  /**
   * Delete, treating "already gone" as success.
   *
   * A caller deleting a Job it just watched finish is racing the API server's own garbage
   * collection and whatever else touched the namespace. Turning that race into a thrown error
   * would make cleanup the thing that fails a run that succeeded.
   */
  async function remove(path: string): Promise<void> {
    try {
      // `propagationPolicy=Background` so deleting a Job takes its pods with it. The default
      // orphans them, which on a sandbox means a customer's container keeps running after the run
      // that created it is over.
      await request("DELETE", `${path}?propagationPolicy=Background`)
    } catch (error) {
      if (error instanceof KubeError && error.status === 404) return
      throw error
    }
  }

  /**
   * A pod's logs, which are `text/plain` rather than JSON.
   *
   * Separate from `request` because that one parses every response as JSON, and log output is the
   * one endpoint in this client that is not. Returns "" for a pod that has not started or has
   * already been collected, because an absent log is not an error — it is a run with nothing to
   * say, and the exit code is what decides.
   */
  async function logs(path: string): Promise<string> {
    // Accept anything, not `text/plain`.
    //
    // The `/log` subresource *returns* plain text and refuses to be *asked* for it: the API server
    // negotiates content against the standard resource list and answers `only the following media
    // types are accepted: application/json, application/yaml, application/vnd.kubernetes.protobuf`
    // — a 406 for the one endpoint whose response is none of them. Asking for anything is how to
    // ask for what it actually sends.
    //
    // Line comments rather than a block, because the header's value contains the two characters
    // that end one. Written as a block it closed on the header itself and silently commented out
    // the rest of the function; the lint went from 0 errors to 107.
    const headers: Record<string, string> = { Accept: "*/*" }
    if (config.token !== undefined) headers.Authorization = `Bearer ${config.token()}`

    const { status, text } = await send(`${config.server}${path}`, "GET", headers, undefined, agent)
    if (status === 404 || status === 400) return ""
    if (status < 200 || status >= 300) throw new KubeError(status, path, text.slice(0, 500))
    return text
  }

  return { apply, get, remove, logs }
}

/**
 * One HTTPS request, with a CA the caller chose.
 *
 * Deliberately small: this is not a general HTTP client, it is the four verbs the Kubernetes API
 * needs plus the ability to trust a certificate authority `fetch` cannot be told about.
 */
async function send(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  agent: Agent | undefined,
): Promise<{ status: number; text: string }> {
  return await new Promise((resolve, reject) => {
    const request = httpsRequest(
      url,
      { method, headers, ...(agent === undefined ? {} : { agent }) },
      (response) => {
        const chunks: Buffer[] = []
        response.on("data", (chunk: Buffer) => chunks.push(chunk))
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf8"),
          })
        })
      },
    )

    request.on("error", reject)
    if (body !== undefined) request.write(body)
    request.end()
  })
}

/** Where a Knative Service lives in the API. */
export function knativeServicePath(namespace: string, name: string): string {
  return `/apis/serving.knative.dev/v1/namespaces/${encodeURIComponent(namespace)}/services/${encodeURIComponent(name)}`
}
