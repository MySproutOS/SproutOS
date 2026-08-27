import {
  CreateAliasCommand,
  CreateFunctionCommand,
  GetAliasCommand,
  DeleteFunctionCommand,
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
import { mintProjectToken } from "./project-token"
import { LAMBDA_ARCHITECTURE, webAdapterEnv } from "./web-adapter"

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
  /** Signed into the telemetry token so the extension body cannot choose a billing owner. */
  organizationId: string
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
  /**
   * The Lambda Web Adapter's layer ARN, when this build is an HTTP server rather than a handler.
   *
   * Set for the `next` and `hono` presets, which produce a server that listens on a port. Absent,
   * the function is published as an ordinary handler — so this is the one switch between the two
   * conventions, and both halves of it (the layer and the `AWS_LAMBDA_EXEC_WRAPPER` variable it
   * needs) are applied together here rather than by two callers who could disagree.
   */
  webAdapterLayerArn?: string
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
  const inspected = await inspectFunction(client, name)

  /*
    A function on the wrong architecture is replaced, not updated.

    Deleting loses the version history, and therefore the ability to roll back to a release
    published before the move. That is the honest trade: those versions cannot run — they carry a
    layer built for the other machine — so keeping them would preserve a rollback target that fails
    at init. Once every function is on this architecture, this branch never runs again.
  */
  if (inspected.exists && !inspected.architectureMatches) {
    await client.send(new DeleteFunctionCommand({ FunctionName: name }))
  }
  const exists = inspected.exists && inspected.architectureMatches
  /*
    One list, computed once, used by both branches.

    The update branch sends `Layers: []` when there is nothing to attach — Lambda treats an omitted
    `Layers` as "leave them alone", so a project that once had a layer would keep it forever after
    the reason for it went away.
  */
  const layers = [input.logExtensionLayerArn, input.webAdapterLayerArn].filter(
    (arn): arn is string => arn !== undefined,
  )

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
        Layers: layers,
      }),
    )
    await waitUntilFunctionUpdatedV2({ client, maxWaitTime: 120 }, { FunctionName: name })
  } else {
    await client.send(
      new CreateFunctionCommand({
        FunctionName: name,
        Role: input.roleArn,
        /*
          Set explicitly, because not setting it is also a choice and it was the wrong one.

          Lambda defaults to `x86_64`; the log extension attached to every customer function is an
          `aarch64` binary. Every invocation died on `cannot execute binary file` as an
          `Extension.Crash`, which reads as the customer's application failing.
        */
        Architectures: [LAMBDA_ARCHITECTURE],
        Handler: input.handler,
        Runtime: input.runtime,
        MemorySize: input.memoryMb,
        Timeout: input.timeoutS,
        Code: { S3Bucket: input.bucket, S3Key: input.key },
        Environment: { Variables: withTelemetryEnv(input) },
        ...(layers.length === 0 ? {} : { Layers: layers }),
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
    ...logEnv(input.projectId, input.organizationId),
    /*
      Last, so it wins over a customer's own `PORT`.

      The adapter and the server have to agree on one number. A customer who sets `PORT` in their
      project settings is describing where their server listens locally; honouring it here would
      leave the adapter forwarding to the wrong port and every invocation timing out with nothing in
      the log to say why.
    */
    ...(input.webAdapterLayerArn === undefined ? {} : webAdapterEnv()),
  }
}

/**
 * Where the extension sends what it collects, and what it proves about itself.
 *
 * **This used to be a Kafka credential.** The extension held a SASL username and password, opened a
 * TLS connection to the broker and produced directly. Two things were wrong with that. The
 * credential sat in the function's environment, which the customer's own code can read — `process.env`
 * is not a boundary against the process it belongs to. And it was authorized to write the shared
 * `runtime-logs` topic, which Kafka cannot restrict by message content, so anyone holding it could
 * publish records carrying another tenant's `project_id`. Those records carry `billed_ms`. Forged
 * logs were forged bills.
 *
 * What goes in now is a token that says one thing: *this is project X*. The router verifies it and
 * stamps the project itself, discarding whatever the payload claimed. The customer can still read
 * the token, and it is worth nothing beyond writing logs to their own project — which `console.log`
 * already does.
 *
 * Long-lived on purpose. It is minted at publish time and lives with the function version, so
 * rotation is a redeploy. A short expiry would mean a function that stops being able to log some
 * time after it was last released, which is a failure nobody would connect to a token.
 */
const LOG_TOKEN_TTL_SECONDS = 400 * 24 * 60 * 60

function logEnv(projectId: string, organizationId: string): Record<string, string> {
  const endpoint = process.env.SPROUTOS_LOG_ENDPOINT ?? ""
  const secret = process.env.LOG_TOKEN_SECRET ?? ""

  // Both or neither. An extension given an endpoint and no token posts batches that are refused on
  // every invocation, which costs the customer time to deliver nothing.
  if (endpoint === "" || secret === "") return {}

  const expiresAt = Math.floor(Date.now() / 1000) + LOG_TOKEN_TTL_SECONDS

  return {
    SPROUTOS_LOG_ENDPOINT: endpoint,
    // The organization-bearing format `services/router/src/log_token.rs` verifies, against one set
    // of fixtures both languages read.
    SPROUTOS_LOG_TOKEN: mintProjectToken(projectId, organizationId, expiresAt, secret),
  }
}

/**
 * Whether the function is there, and whether it is on the architecture we publish.
 *
 * The second half exists because the first answer alone is not enough to decide between create and
 * update. `Architectures` is fixed at creation — `UpdateFunctionConfiguration` does not accept it —
 * so a function created before this platform chose an architecture would be updated in place
 * forever and stay on the wrong one, attaching layers built for the other machine and crashing at
 * init on every invocation. Answering "yes it exists" there is technically true and operationally a
 * dead end.
 */
async function inspectFunction(
  client: LambdaClient,
  name: string,
): Promise<{ exists: boolean; architectureMatches: boolean }> {
  try {
    const found = await client.send(new GetFunctionCommand({ FunctionName: name }))
    const architectures = found.Configuration?.Architectures ?? []
    return {
      architectureMatches: architectures.includes(LAMBDA_ARCHITECTURE),
      exists: true,
    }
  } catch (cause) {
    if (cause instanceof ResourceNotFoundException)
      return { architectureMatches: true, exists: false }
    throw cause
  }
}
