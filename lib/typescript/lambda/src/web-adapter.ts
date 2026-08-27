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
 * The layer version this platform publishes against. `29` is the adapter's `1.1.0`.
 *
 * **Pinned in code rather than in configuration**, and the difference is not stylistic. The first
 * version of this read the environment and refused to publish when nothing was set — which is the
 * right shape for a credential and the wrong one for a constant, because the control-plane deploy
 * does not run `tofu apply`. The variable would have reached instances only on the next
 * infrastructure change, and until then every web deployment would have been refused for want of a
 * public number that has one correct value.
 *
 * Here it is a code change with a diff and a review, which is what moving every customer function
 * to a new adapter build deserves. The environment still overrides it, for a region or an
 * experiment that needs something else.
 */
export const DEFAULT_WEB_ADAPTER_LAYER_VERSION = "29"

/**
 * The architecture every customer function is published on.
 *
 * **Stated once, because it was never stated at all.** `publishFunction` did not set
 * `Architectures`, so Lambda used its default of `x86_64` — while the log extension layer, the only
 * one this platform builds, is `aarch64-unknown-linux-musl` (`AGENTS.md` names that target) and was
 * published declaring `arm64`. Lambda attached it anyway and every invocation died on
 * `/opt/extensions/log-extension: cannot execute binary file`, reported as `Extension.Crash` — a
 * failure in the customer's function with no cause anywhere in the customer's code.
 *
 * `arm64` rather than rebuilding the extension: Graviton is cheaper per millisecond for identical
 * work, and it is the architecture the one binary we ship is already built for. The cost is that a
 * build produced on a GitHub `ubuntu-latest` runner is an x86-64 machine's output, so a project with
 * a compiled native dependency would ship the wrong `.node` file. The deploy action checks for that
 * and refuses, because the alternative is a module-not-found at runtime that names a file rather
 * than an architecture.
 *
 * **Not changeable in place.** `UpdateFunctionConfiguration` does not accept `Architectures`, so a
 * function created before this has to be deleted to move.
 */
export const LAMBDA_ARCHITECTURE = "arm64" as const

/**
 * AWS's published account for the adapter layer. Not ours, and not a secret.
 *
 * Returns `undefined` only when an override is explicitly set to something unusable, so the publish
 * can refuse: a function with the wrapper variable set and no `/opt/bootstrap` fails on every
 * invocation, and the alias would already have moved by the time anyone saw it.
 */
export function webAdapterLayerArn(region: string): string | undefined {
  const explicit = process.env.LAMBDA_WEB_ADAPTER_LAYER_ARN
  if (explicit !== undefined && explicit !== "") return explicit

  // An override present but blank is "unset", not "no layer": an unset Terraform variable arrives
  // as `VAR=` rather than as an absent name, so `??` would take the empty string and compose an ARN
  // ending in a colon.
  const configured = process.env.LAMBDA_WEB_ADAPTER_LAYER_VERSION
  const version =
    configured === undefined || configured === "" ? DEFAULT_WEB_ADAPTER_LAYER_VERSION : configured

  // `Arm64`, matching `LAMBDA_ARCHITECTURE`. The two must move together — an adapter built for the
  // other architecture is the same `cannot execute binary file` this platform already shipped once.
  return `arn:aws:lambda:${region}:753240598075:layer:LambdaAdapterLayerArm64:${version}`
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
    // Without this, an adapted HTTP server can return 500 and Lambda still records the invocation
    // as successful. Queue drains are asynchronous Lambda events, so Lambda's two built-in retries
    // only happen when the adapter translates the response into an invocation error.
    AWS_LWA_ERROR_STATUS_CODES: "500-599",
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
