import {
  DeleteFunctionCommand,
  CreateFunctionCommand,
  GetFunctionCommand,
  InvokeCommand,
  LambdaClient,
  ResourceNotFoundException,
  UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand,
  waitUntilFunctionUpdatedV2,
  type InvokeCommandOutput,
  type Runtime,
} from "@aws-sdk/client-lambda"
import type { Architecture } from "@aws-sdk/client-lambda"
import { LAMBDA_ARCHITECTURE } from "./web-adapter"

/**
 * Running a project's migrations, to completion, before its new code serves traffic.
 *
 * A separate function from the one that serves requests — `sproutos-migrate-<project id>` beside
 * `sproutos-app-<project id>`. Three reasons, in order of how much they cost to get wrong:
 *
 * 1. **A migrator is a different program.** Different entry point, usually different dependencies.
 *    Bundling it into the request-serving function puts migration tooling in the cold-start path of
 *    every request forever.
 * 2. **It needs a different timeout.** The application's is seconds because a request that takes
 *    minutes is already broken; a migration legitimately takes minutes.
 * 3. **It must not be reachable.** The app function is behind a route a stranger can hit. This one
 *    has no route and no alias, so the only thing that can invoke it is this code.
 *
 * ## The ceiling is real and must be said out loud
 *
 * Lambda's hard maximum is 15 minutes. A migration that needs longer cannot run here, and finding
 * that out halfway through is the worst possible moment — a migration killed mid-run leaves a
 * schema in a state its own tooling did not choose. Callers surface {@link MIGRATION_TIMEOUT_S}.
 */

/** Lambda's hard ceiling. Not a tuning knob — the API refuses anything larger. */
export const MIGRATION_TIMEOUT_S = 15 * 60

/** Memory for a migrator. Generous, because CPU on Lambda scales with it and migrations are IO-bound bursts. */
const MIGRATION_MEMORY_MB = 1024

export function migrationFunctionName(projectId: string): string {
  return `sproutos-migrate-${projectId}`
}

export type MigrateInput = {
  projectId: string
  bucket: string
  key: string
  handler: string
  runtime: Runtime
  roleArn: string
  environment: Record<string, string>
  timeoutS?: number
}

export type MigrateResult = {
  ok: boolean
  /** What the migrator said, trimmed. The only thing worth showing a customer whose deploy stopped. */
  output: string
}

/**
 * Invoke a migrator with a client whose retry budget is exactly one attempt.
 *
 * Function publication still uses the caller's ordinary client and retry policy. Only the
 * dangerous boundary is cloned: a retry of CreateFunction is harmless convergence, while a retry
 * of RequestResponse after a lost response can execute a partially applied schema change twice.
 */
export async function invokeMigrationOnce(
  client: LambdaClient,
  functionName: string,
): Promise<InvokeCommandOutput> {
  const singleAttempt = new LambdaClient({
    region: client.config.region,
    credentials: client.config.credentials,
    endpoint: client.config.endpoint,
    requestHandler: client.config.requestHandler,
    logger: client.config.logger,
    maxAttempts: 1,
  })

  return singleAttempt.send(
    new InvokeCommand({
      FunctionName: functionName,
      InvocationType: "RequestResponse",
      // The last 4 KB of the migrator's own logs, base64 in a header. Far more useful than the
      // return value, which for most migrators is `undefined`.
      LogType: "Tail",
    }),
  )
}

/**
 * Publish the migrator and run it once, synchronously.
 *
 * `RequestResponse`, not `Event`. The whole point is to know whether it worked before the alias
 * moves — an asynchronous invoke would return immediately and the deploy would proceed past a
 * migration that had not finished, which is precisely the ordering this exists to prevent.
 */
export async function runMigration(
  client: LambdaClient,
  input: MigrateInput,
): Promise<MigrateResult> {
  const name = migrationFunctionName(input.projectId)
  const timeout = Math.min(input.timeoutS ?? MIGRATION_TIMEOUT_S, MIGRATION_TIMEOUT_S)

  const exists = await functionExists(client, name, LAMBDA_ARCHITECTURE)

  if (exists) {
    await client.send(
      new UpdateFunctionCodeCommand({
        FunctionName: name,
        S3Bucket: input.bucket,
        S3Key: input.key,
      }),
    )
    // Lambda serialises updates to one function and rejects a second while the first runs; without
    // this the configuration update fails as an intermittent `ResourceConflictException`.
    await waitUntilFunctionUpdatedV2({ client, maxWaitTime: 120 }, { FunctionName: name })

    await client.send(
      new UpdateFunctionConfigurationCommand({
        FunctionName: name,
        Handler: input.handler,
        Runtime: input.runtime,
        MemorySize: MIGRATION_MEMORY_MB,
        Timeout: timeout,
        Environment: { Variables: input.environment },
      }),
    )
    await waitUntilFunctionUpdatedV2({ client, maxWaitTime: 120 }, { FunctionName: name })
  } else {
    await client.send(
      new CreateFunctionCommand({
        FunctionName: name,
        Role: input.roleArn,
        /*
          The same architecture the application runs on, stated for the same reason.

          `publishFunction` was corrected and this was not — which is the exact pattern
          `docs/findings/0018` closes on: every fix in that list already existed somewhere,
          applied to something adjacent. A migrator with a compiled dependency built for the
          runner's machine would fail here in a way that has nothing to do with migrations.
        */
        Architectures: [LAMBDA_ARCHITECTURE],
        Handler: input.handler,
        Runtime: input.runtime,
        MemorySize: MIGRATION_MEMORY_MB,
        Timeout: timeout,
        Code: { S3Bucket: input.bucket, S3Key: input.key },
        Environment: { Variables: input.environment },
      }),
    )
    await waitUntilFunctionUpdatedV2({ client, maxWaitTime: 120 }, { FunctionName: name })
  }

  const invoked = await invokeMigrationOnce(client, name)

  const logs =
    invoked.LogResult === undefined ? "" : Buffer.from(invoked.LogResult, "base64").toString("utf8")

  const payload = invoked.Payload === undefined ? "" : new TextDecoder().decode(invoked.Payload)

  /*
    `FunctionError` is how Lambda reports a handler that threw.

    The HTTP call succeeds either way — a migration that failed is a *successful invocation of a
    function that raised*, and treating a 200 as success is the classic way this check turns into
    decoration. Checked explicitly.
  */
  const ok = invoked.FunctionError === undefined && (invoked.StatusCode ?? 0) < 300

  return { ok, output: trim(`${logs}\n${payload}`.trim()) }
}

/** Enough to diagnose, bounded so a chatty migrator cannot fill a column read on a list page. */
const MAX_OUTPUT = 8000

function trim(text: string): string {
  if (text.length <= MAX_OUTPUT) return text
  return `${text.slice(0, MAX_OUTPUT)}\n…truncated (${text.length - MAX_OUTPUT} more characters)`
}

/**
 * Whether the migrator exists *and* is on the architecture we publish.
 *
 * A function created before this platform chose one cannot be moved: `UpdateFunctionConfiguration`
 * does not accept `Architectures`. Answering "yes it exists" would update it in place forever on
 * the wrong machine. Deleting a migrator costs nothing — it holds no alias and no version anyone
 * rolls back to; it is republished from the archive on every run.
 */
async function functionExists(
  client: LambdaClient,
  name: string,
  architecture: Architecture,
): Promise<boolean> {
  try {
    const found = await client.send(new GetFunctionCommand({ FunctionName: name }))
    if (!(found.Configuration?.Architectures ?? []).includes(architecture)) {
      await client.send(new DeleteFunctionCommand({ FunctionName: name }))
      return false
    }
    return true
  } catch (cause) {
    if (cause instanceof ResourceNotFoundException) return false
    throw cause
  }
}
