import { InvokeCommand, type LambdaClient, ResourceNotFoundException } from "@aws-sdk/client-lambda"
import { functionName, LIVE_ALIAS } from "@lib/lambda"

/**
 * Running a workflow node that must not run in the control plane.
 *
 * Some nodes carry a customer-supplied destination or customer-supplied code. Those used to run as
 * a Kubernetes Job in the tenant's own namespace, where a NetworkPolicy was the boundary. Under
 * ADR 0026 there is no cluster, and the boundary is Lambda's own: one execution environment per
 * function, and the function is the customer's.
 *
 * **The isolation argument is the same one, made cheaper.** The point was never the namespace — it
 * was that customer-supplied code must not execute in a process holding the platform's credentials.
 * A Lambda invocation of the project's own function satisfies that by construction: it is already
 * their code, already running under their execution role, already unable to see ours.
 *
 * ## The protocol
 *
 * The node is delivered to the project's `live` alias as an event with a `sproutos` envelope, so a
 * customer's HTTP handler can tell it apart from a web request — the two arrive at the same
 * function. The workflow scaffolding SproutOS adds to a forked project answers it; a project
 * without that scaffolding returns whatever it returns, and the node records that as its output.
 */

export type NodeRun = {
  runId: string
  nodeId: string
  nodeType: string
  projectId: string
  config: Record<string, unknown>
  /** The event/manual/cron value that started the graph. Kept separate from immutable node config. */
  trigger?: unknown
  timeoutSeconds?: number
}

export type NodeResult =
  | { state: "ok"; output: unknown }
  | { state: "failed"; reason: string }
  /** No function to run it in. The project was never deployed. */
  | { state: "unrunnable"; reason: string }

export async function runNodeInLambda(client: LambdaClient, input: NodeRun): Promise<NodeResult> {
  const event = {
    sproutos: {
      kind: "workflow.node",
      runId: input.runId,
      nodeId: input.nodeId,
      nodeType: input.nodeType,
      config: input.config,
      trigger: input.trigger ?? null,
    },
  }

  let response
  try {
    response = await client.send(
      new InvokeCommand({
        // The alias, not a version: a node runs against whatever is live, the same code serving the
        // project's web traffic. A pinned version would let a workflow keep running code the
        // customer rolled back.
        FunctionName: `${functionName(input.projectId)}:${LIVE_ALIAS}`,
        Payload: JSON.stringify(event),
      }),
    )
  } catch (cause) {
    if (cause instanceof ResourceNotFoundException) {
      /*
        Nowhere to run it, and that is not a failure of the node.

        This is the Lambda equivalent of the old "this project has no tenant namespace" case: a
        workflow on a project that has never deployed. Reported as its own state rather than as a
        failure, because retrying will not help and the customer's fix is to deploy.
      */
      return {
        state: "unrunnable",
        reason:
          `${input.nodeType} runs inside the project's own deployment, and this project has not ` +
          `been deployed yet. Deploy it once and the workflow can run.`,
      }
    }
    return { state: "failed", reason: cause instanceof Error ? cause.message : String(cause) }
  }

  // An unhandled error inside the customer's code. Lambda answers 200 with `FunctionError` set, so
  // reading the payload as a result would record their stack trace as the node's output.
  if (response.FunctionError !== undefined) {
    const detail = Buffer.from(response.Payload ?? new Uint8Array()).toString("utf8")
    return { state: "failed", reason: detail.slice(0, 2000) }
  }

  const raw = Buffer.from(response.Payload ?? new Uint8Array()).toString("utf8")
  try {
    return { state: "ok", output: JSON.parse(raw) as unknown }
  } catch {
    // Not JSON. Kept as text rather than discarded — a node that printed something useful should
    // not lose it because the handler forgot to serialise.
    return { state: "ok", output: raw }
  }
}
