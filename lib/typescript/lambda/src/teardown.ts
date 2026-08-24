import {
  DeleteFunctionCommand,
  type LambdaClient,
  ResourceNotFoundException,
} from "@aws-sdk/client-lambda"
import type { Redis } from "ioredis"
import { functionName } from "./publish"
import { withdrawRoute } from "./routes"

/**
 * Taking a project's compute away.
 *
 * **Order matters and it is the opposite of publishing.** A release publishes the function first
 * and the route last, so traffic never points at nothing. A teardown withdraws the route *first*,
 * so nothing is pointing at the function by the time it is deleted — otherwise there is a window
 * where the router resolves a host to an ARN that no longer exists, and every request in it gets a
 * 502 rather than the 404 the project has earned.
 *
 * The route is withdrawn by the hostname stored on the deployment, not by one recomputed from the
 * project. A project renamed since it deployed would otherwise have its old hostname left resolving
 * — a deleted project still serving, which is the failure this whole path exists to prevent.
 */
export async function tearDownDeployment(
  clients: { lambda: LambdaClient; valkey: Redis },
  input: { projectId: string; hostname: string | null },
): Promise<void> {
  if (input.hostname !== null) {
    await withdrawRoute(clients.valkey, input.hostname)
  }

  await deleteFunction(clients.lambda, input.projectId)
}

/**
 * Delete a project's function and every version of it.
 *
 * A function that is already gone is a success, not an error. Teardown is retried — the job runner
 * will run this again after any later step fails — and a second pass that threw on the work the
 * first pass completed would never get past it.
 */
export async function deleteFunction(client: LambdaClient, projectId: string): Promise<void> {
  try {
    // No `Qualifier`: that would delete one version and leave the rest, which still cost storage
    // and can still be invoked by anything holding their ARNs.
    await client.send(new DeleteFunctionCommand({ FunctionName: functionName(projectId) }))
  } catch (cause) {
    if (cause instanceof ResourceNotFoundException) return
    throw cause
  }
}
