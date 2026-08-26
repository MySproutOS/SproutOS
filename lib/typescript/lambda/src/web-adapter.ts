/**
 * Running an ordinary HTTP server on Lambda, unmodified.
 *
 * ## The gap this closes
 *
 * `publishFunction` published every customer build with `handler: "index.handler"` — a Lambda entry
 * point, meaning an exported function. What the presets actually produce is a *web server*:
 * `.next/standalone` contains `server.js`, which listens on a port, and a Hono `dist` is the same
 * shape. Neither exports `index.handler`, so every function would have failed at
 * `Runtime.HandlerNotFound`.
 *
 * Nothing caught it because no deployment ever got that far: they all died earlier on "No build
 * artifact was uploaded for this release", and **every deployment in the production account has
 * status `error`** — the Lambda compute path of ADR 0026 has never served a request.
 *
 * ## Why an adapter rather than a handler
 *
 * The alternative is requiring every customer to export a Lambda handler, which contradicts the
 * product: "fork this app and it runs" cannot also mean "first learn Lambda's calling convention".
 * AWS's Lambda Web Adapter is a layer that translates an invocation into an HTTP request against a
 * server it starts inside the sandbox, so a Next.js or Hono app deploys exactly as it runs locally.
 *
 * ## How it works on a zip deployment
 *
 * Three things together, and all three are required:
 *
 * 1. The **layer**, which puts `/opt/bootstrap` in the image.
 * 2. `AWS_LAMBDA_EXEC_WRAPPER=/opt/bootstrap`, which makes Lambda run that wrapper instead of the
 *    Node runtime. Without it the layer is present and inert — the function still looks for a
 *    handler export and still fails, which is the failure mode worth naming because the layer being
 *    attached makes it look configured.
 * 3. The **handler as a startup script** — `run.sh` in the archive, which `exec`s the server. The
 *    wrapper runs it and waits for the port to answer.
 */

/** Where the adapter listens for the application. Next and Hono are told to bind here. */
export const WEB_ADAPTER_PORT = 8080

/** The script the archive must contain, and what `handler` is set to for an adapted deployment. */
export const WEB_ADAPTER_HANDLER = "run.sh"

/**
 * AWS's published account for the adapter layer. Not ours, and not a secret.
 *
 * The version is pinned through the environment rather than hardcoded: layer versions advance, a
 * stale one is a silent old adapter, and a wrong one fails at publish with an AWS error naming the
 * ARN — which is the good failure. Absent, adapted deployments are refused rather than published
 * without the layer, because a function with the wrapper variable set and no `/opt/bootstrap` boots
 * into an error every invocation.
 */
export function webAdapterLayerArn(region: string): string | undefined {
  const explicit = process.env.LAMBDA_WEB_ADAPTER_LAYER_ARN
  if (explicit !== undefined && explicit !== "") return explicit

  const version = process.env.LAMBDA_WEB_ADAPTER_LAYER_VERSION
  if (version === undefined || version === "") return undefined

  // `X86` rather than `Arm64`: `publishFunction` does not set `Architectures`, so Lambda uses its
  // default. A layer for the other architecture fails at publish, which is loud — but the two must
  // be changed together, so they are named in one place.
  return `arn:aws:lambda:${region}:753240598075:layer:LambdaAdapterLayerX86:${version}`
}

/**
 * The environment an adapted function needs, beyond the customer's own.
 *
 * `PORT` is set as well as `AWS_LWA_PORT` because the two ends have to agree and each framework
 * reads a different one: Next's standalone server reads `PORT`, and the adapter reads
 * `AWS_LWA_PORT` to know where to send the request. Setting only one produces a function that
 * starts, listens somewhere, and times out on every invocation.
 */
export function webAdapterEnv(): Record<string, string> {
  return {
    AWS_LAMBDA_EXEC_WRAPPER: "/opt/bootstrap",
    AWS_LWA_PORT: String(WEB_ADAPTER_PORT),
    PORT: String(WEB_ADAPTER_PORT),
    // Bind to every interface. Next's standalone server defaults to localhost, which the adapter —
    // a separate process in the same sandbox — can reach, but a framework that defaults to a
    // specific interface cannot be assumed to.
    HOSTNAME: "0.0.0.0",
  }
}

/** The script an adapted archive must contain at its root, written by the deploy action. */
export function startupScript(command: string): string {
  return `#!/bin/sh
# Started by the Lambda Web Adapter's bootstrap wrapper, not by the Node runtime.
#
# \`exec\` so the server becomes PID 1's child directly and receives Lambda's signals; without it a
# shell sits between them and a shutdown leaves the server running until the sandbox is frozen.
set -e
exec ${command}
`
}
