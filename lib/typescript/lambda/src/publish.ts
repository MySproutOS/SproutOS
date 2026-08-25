import {
  CreateAliasCommand,
  CreateFunctionCommand,
  GetAliasCommand,
  GetFunctionCommand,
  LambdaClient,
  PublishVersionCommand,
  ResourceNotFoundException,
  UpdateAliasCommand,
  UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand,
  type Runtime,
  waitUntilFunctionUpdatedV2,
} from "@aws-sdk/client-lambda"

/**
 * Putting a customer's build on Lambda.
 *
 * One Lambda function per project, not per deployment. A deployment publishes a new *version* of
 * that function and moves an alias, which is what makes a release atomic and a rollback a single
 * `UpdateAlias` rather than a redeploy — the previous version is still there, still invokable, and
 * costs nothing while nothing points at it.
 *
 * Per-deployment functions would be simpler to reason about and are the wrong shape: Lambda's
 * account-wide function count is a quota, a preview per pull request would burn through it, and
 * deleting them on cleanup makes rollback a rebuild.
 */

/** Which version of a project's function the router should invoke. */
export const LIVE_ALIAS = "live"

/**
 * Lambda function names are `[a-zA-Z0-9-_]{1,64}`, so the project UUID goes in with its hyphens and
 * a prefix that makes the function identifiable in a console listing that also holds ours.
 */
export function functionName(projectId: string): string {
  return `sproutos-app-${projectId}`
}

export type PublishInput = {
  projectId: string
  /**
   * Which deployment this is, for attributing a log line to a release.
   *
   * Optional because the function can be published without one — a manual repair, a test — and a
   * log line with no deployment is better than a publish that refuses. The extension writes an
   * empty string into the column when it is absent.
   */
  deploymentId?: string
  /** Where the build archive is. Lambda reads it from S3 itself; we never stream it. */
  bucket: string
  key: string
  handler: string
  /*
    Lambda's own union, not `string`. The set of runtimes is closed and AWS rejects an unknown one
    at deploy time with a message that does not say which field was wrong — the type is the earlier
    and clearer place to find out that `nodejs22` is not `nodejs22.x`.
  */
  runtime: Runtime
  memoryMb: number
  timeoutS: number
  /** The execution role the function assumes. One per environment, not per tenant. */
  roleArn: string
  environment?: Record<string, string>
  /**
   * The log extension's layer ARN.
   *
   * Attached on every publish rather than once at creation. An extension only collects from
   * functions it is attached to, so a project deployed before the layer existed — or one whose
   * layer version moved — would have no logs at all, silently. Re-attaching on every release is
   * how "must be attached" stops being an operational hazard.
   */
  logExtensionLayerArn?: string
}

export type PublishResult = {
  functionName: string
  version: string
  aliasArn: string
}

/**
 * Create or update the project's function, publish a version, and point `live` at it.
 *
 * Idempotent in the sense that matters: calling it twice with the same artifact produces two
 * versions of identical code and leaves the alias on the second. That is wasteful rather than
 * wrong, and the alternative — checking whether the code changed — means trusting a digest Lambda
 * computes differently from the one the deploy action reported.
 */
export async function publishFunction(
  client: LambdaClient,
  input: PublishInput,
): Promise<PublishResult> {
  const name = functionName(input.projectId)
  const exists = await functionExists(client, name)

  if (exists) {
    await client.send(
      new UpdateFunctionCodeCommand({
        FunctionName: name,
        S3Bucket: input.bucket,
        S3Key: input.key,
      }),
    )
    /*
      Wait before touching configuration.

      Lambda serialises updates to one function and rejects a second while the first is in progress
      with `ResourceConflictException`. Under load that reads as an intermittent deploy failure, and
      the cause — that the code update had not finished — is invisible in the error.
    */
    await waitUntilFunctionUpdatedV2({ client, maxWaitTime: 120 }, { FunctionName: name })

    await client.send(
      new UpdateFunctionConfigurationCommand({
        FunctionName: name,
        Handler: input.handler,
        Runtime: input.runtime,
        MemorySize: input.memoryMb,
        Timeout: input.timeoutS,
        Environment: { Variables: withTelemetryEnv(input) },
        Layers: input.logExtensionLayerArn === undefined ? [] : [input.logExtensionLayerArn],
      }),
    )
    await waitUntilFunctionUpdatedV2({ client, maxWaitTime: 120 }, { FunctionName: name })
  } else {
    await client.send(
      new CreateFunctionCommand({
        FunctionName: name,
        Role: input.roleArn,
        Handler: input.handler,
        Runtime: input.runtime,
        MemorySize: input.memoryMb,
        Timeout: input.timeoutS,
        Code: { S3Bucket: input.bucket, S3Key: input.key },
        Environment: { Variables: withTelemetryEnv(input) },
        ...(input.logExtensionLayerArn === undefined
          ? {}
          : { Layers: [input.logExtensionLayerArn] }),
      }),
    )
    await waitUntilFunctionUpdatedV2({ client, maxWaitTime: 120 }, { FunctionName: name })
  }

  const published = await client.send(new PublishVersionCommand({ FunctionName: name }))
  const version = published.Version
  if (version === undefined) {
    throw new Error(`Lambda published no version for ${name}`)
  }

  const aliasArn = await pointAlias(client, name, version)
  return { functionName: name, version, aliasArn }
}

/**
 * Move `live` to an existing version. This is the rollback: no build, no upload, one API call.
 *
 * Asks whether the alias exists rather than trying to update it and treating the failure as
 * "create it instead". Lambda raises the same `ResourceNotFoundException` for a missing alias and a
 * missing *function*, so a catch-and-create turns "that project was never deployed" into a second
 * identical failure with a misleading trail — the create fails for the original reason, and the
 * update's error, which said so, has been swallowed.
 */
export async function pointAlias(
  client: LambdaClient,
  name: string,
  version: string,
): Promise<string> {
  const existing = await aliasExists(client, name)

  const result = existing
    ? await client.send(
        new UpdateAliasCommand({ FunctionName: name, Name: LIVE_ALIAS, FunctionVersion: version }),
      )
    : await client.send(
        new CreateAliasCommand({ FunctionName: name, Name: LIVE_ALIAS, FunctionVersion: version }),
      )

  if (result.AliasArn === undefined) throw new Error(`no alias ARN for ${name}`)
  return result.AliasArn
}

async function aliasExists(client: LambdaClient, name: string): Promise<boolean> {
  try {
    await client.send(new GetAliasCommand({ FunctionName: name, Name: LIVE_ALIAS }))
    return true
  } catch (cause) {
    if (cause instanceof ResourceNotFoundException) return false
    throw cause
  }
}

/**
 * The customer's own variables, plus what the extension needs to attribute their logs.
 *
 * The extension runs inside their environment and has no way to know whose function it is in —
 * there is no project id in anything Lambda tells it. These two are how a log line gets a project.
 *
 * Set here rather than left to the extension to look up: a lookup would be a network call per cold
 * start, inside the customer's billed duration, for a value that never changes for the life of the
 * function version.
 */
function withTelemetryEnv(input: PublishInput): Record<string, string> {
  return {
    ...input.environment,
    SPROUTOS_PROJECT_ID: input.projectId,
    ...(input.deploymentId === undefined ? {} : { SPROUTOS_DEPLOYMENT_ID: input.deploymentId }),
    ...kafkaEnv(),
  }
}

/**
 * Where the extension sends what it collects, and what it authenticates with.
 *
 * These are the platform's settings rather than the project's, so they come from the control
 * plane's own environment and are written onto every function — a customer never sets them and
 * `input.environment` is spread *before* these, so a customer cannot override them either.
 *
 * **Every variable or none.** A partially configured extension is the worst of the three states: it
 * starts, subscribes, collects the customer's logs into their memory, and then fails to produce
 * them on every flush. Leaving them all unset is a well-defined mode — `kafka.ts` connects without
 * SASL and, with no `KAFKA_BROKERS` at all, `connect()` fails loudly at start rather than quietly
 * forever.
 *
 * The password is a platform credential authorized to write one topic (see `ovh/docker-compose.yaml`).
 * It is on the function's configuration, which means anyone who can read the function's
 * configuration can read it — that is why it is scoped to `Write` on `runtime-logs` and nothing
 * else, and why the ACL is the boundary rather than the secrecy of this string.
 */
function kafkaEnv(): Record<string, string> {
  const brokers = process.env.KAFKA_BROKERS ?? ""
  const username = process.env.KAFKA_SASL_USERNAME ?? ""
  const password = process.env.KAFKA_SASL_PASSWORD ?? ""

  if (brokers === "") return {}

  if (username !== "" && password === "") {
    throw new Error("KAFKA_SASL_USERNAME is set but KAFKA_SASL_PASSWORD is not")
  }

  return {
    KAFKA_BROKERS: brokers,
    KAFKA_RUNTIME_LOG_TOPIC: process.env.KAFKA_RUNTIME_LOG_TOPIC ?? "runtime-logs",
    // Must match the topic's actual partition count. The extension hashes a project onto one of
    // these and asks for it by number, so a value larger than the topic has is a project whose
    // logs never arrive — and it is the topic that is authoritative, not this default.
    KAFKA_RUNTIME_LOG_PARTITIONS: process.env.KAFKA_RUNTIME_LOG_PARTITIONS ?? "3",
    ...(username === "" ? {} : { KAFKA_SASL_USERNAME: username, KAFKA_SASL_PASSWORD: password }),
  }
}

async function functionExists(client: LambdaClient, name: string): Promise<boolean> {
  try {
    await client.send(new GetFunctionCommand({ FunctionName: name }))
    return true
  } catch (cause) {
    if (cause instanceof ResourceNotFoundException) return false
    throw cause
  }
}
