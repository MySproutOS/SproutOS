import {
  bootstrapSandbox,
  harnessFor,
  renderSproutosSkill,
  resolveAgentCredential,
} from "@lib/agent"
import {
  crudAgentSession,
  crudDatabaseBranch,
  crudMeteringOutbox,
  crudSandbox,
  fetchDatabaseBranch,
  fetchGithubInstallation,
  fetchSandbox,
  fetchSandboxDatabaseBranch,
} from "@lib/dao"
import { createGitHubClient, createInstallationTokenStore, envAppJwtSigner } from "@lib/github"
import { encodeUsageEvent, usageEventRecord, type BillableDimension } from "@lib/metering"
import {
  createDevBranch,
  dropDevBranch,
  MAX_SANDBOX_DATABASE_BRANCHES,
  neonPostgresConfigFromEnv,
} from "@lib/services"
import { daytonaClientFromEnv, SandboxNotFoundError } from "@lib/sandbox"
import type { DaytonaSandboxClient } from "@lib/sandbox"
import type { DB, JsonValue } from "@sproutos/db"
import { sql, type Kysely, type Selectable } from "kysely"
import { v7 } from "uuid"
import { enqueue } from "./queue"
import type { JobHandler } from "./worker"

export const SANDBOX_KINDS = {
  provision: "sandbox.provision",
  start: "sandbox.start",
  stop: "sandbox.stop",
  destroy: "sandbox.destroy",
  reconcile: "sandbox.reconcile",
  reap: "sandbox.reap",
  meter: "sandbox.meter",
  reapDatabaseBranches: "sandbox.database_branch.reap",
  repairDestroy: "sandbox.destroy.repair",
} as const

const DATABASE_BRANCH_REAP_BATCH_SIZE = 25

/**
 * What a sandbox costs us, per second, in micro-USD.
 *
 * Daytona's published rates are per hour: $0.0504 per vCPU, $0.0162 per GiB of memory, and
 * $0.000108 per GiB of disk. Divided by 3600 and expressed in micro-USD, which is the unit every
 * money figure in this schema uses.
 *
 * Here so the price book can be compared against it. `price_book` charges the customer; these are
 * what the platform pays, and a rate below its neighbour here is a sandbox sold at a loss with no
 * error state — `docs/findings/0011-the-platform-was-free.md` is the same failure one step further
 * along.
 */
export const PROVIDER_COST_MICRO_USD_PER_SECOND = {
  cpu: 14,
  memoryGib: 4.5,
  diskGib: 0.03,
} as const

/** One usage row per resource, so each can be priced and shown separately. */
const DIMENSIONS = {
  cpu: "sandbox_cpu_second",
  memoryGib: "sandbox_gib_second",
  diskGib: "sandbox_disk_gib_second",
} as const satisfies Record<string, BillableDimension>

export async function requestSandboxStart(
  db: Kysely<DB>,
  input: {
    organizationId: string
    projectId: string
    userId: string
    idleTimeoutS: number
  },
): Promise<Selectable<DB["sandbox"]>> {
  return await db.transaction().execute(async (tx) => {
    let sandbox = await fetchSandbox(tx).forUserForUpdate(
      input.organizationId,
      input.projectId,
      input.userId,
    )

    if (sandbox === undefined) {
      sandbox = await crudSandbox(tx).createIfAbsent({
        projectId: input.projectId,
        userId: input.userId,
        state: "starting",
        idleTimeoutS: input.idleTimeoutS,
      })

      if (sandbox !== undefined) {
        await enqueue(tx, {
          kind: SANDBOX_KINDS.provision,
          organizationId: input.organizationId,
          payload: { sandboxId: sandbox.id },
          idempotencyKey: `${SANDBOX_KINDS.provision}:${sandbox.id}`,
          maxAttempts: 3,
        })
        return sandbox
      }

      sandbox = await fetchSandbox(tx).forUserForUpdate(
        input.organizationId,
        input.projectId,
        input.userId,
      )
      if (sandbox === undefined) throw new Error("sandbox uniqueness conflict produced no row")
    }

    if (sandbox.state === "stopped" || sandbox.state === "failed") {
      const kind =
        sandbox.state === "failed" || sandbox.externalId === null
          ? SANDBOX_KINDS.provision
          : SANDBOX_KINDS.start
      const transitioned = await crudSandbox(tx).updateIfState(sandbox.id, ["stopped", "failed"], {
        state: "starting",
        lastActivityAt: sql<Date>`now()` as unknown as Date,
      })
      if (transitioned !== undefined) {
        await enqueue(tx, {
          kind,
          organizationId: input.organizationId,
          payload: { sandboxId: sandbox.id },
          idempotencyKey: `${kind}:${sandbox.id}:${transitioned.updatedAt.toISOString()}`,
          maxAttempts: 3,
        })
        return transitioned
      }
    }

    if (sandbox.state === "deleting") throw new SandboxDeletingError(sandbox.id)

    await crudSandbox(tx).touch(sandbox.id)
    return sandbox
  })
}

export class SandboxDeletingError extends Error {
  override readonly name = "SandboxDeletingError"

  constructor(readonly sandboxId: string) {
    super(`sandbox ${sandboxId} is being deleted`)
  }
}

export async function requestSandboxDestroy(
  db: Kysely<DB>,
  input: { organizationId: string; projectId: string; userId: string },
): Promise<Selectable<DB["sandbox"]> | undefined> {
  return await db.transaction().execute(async (tx) => {
    const sandbox = await fetchSandbox(tx).forUserForUpdate(
      input.organizationId,
      input.projectId,
      input.userId,
    )
    if (sandbox === undefined) return undefined

    const deleting =
      sandbox.state === "deleting"
        ? sandbox
        : ((await crudSandbox(tx).updateIfState(
            sandbox.id,
            ["starting", "running", "idle", "stopped", "failed"],
            { state: "deleting" },
          )) ?? sandbox)

    await enqueue(tx, {
      kind: SANDBOX_KINDS.destroy,
      organizationId: input.organizationId,
      payload: { sandboxId: sandbox.id },
      idempotencyKey: `${SANDBOX_KINDS.destroy}:${sandbox.id}`,
      maxAttempts: 3,
    })
    await crudAgentSession(tx).archiveRestorableForSandboxScope(input.projectId, input.userId)
    return deleting
  })
}

/**
 * Meter every provider-backed sandbox up to now.
 *
 * **Not only at stop.** A stop that never completes — a crashed worker, a provider timeout, a
 * sandbox someone forgets — would otherwise be free compute for as long as it runs, and free
 * compute has no error state. So the bill accrues on a schedule and stopping settles the tail.
 * Daytona continues billing a stopped container's reserved disk until it is archived or deleted,
 * so stopped provider objects remain candidates but emit only `sandbox_disk_gib_second`.
 *
 * Quantity comes from our own numbers: the resource shape we asked the provider for, and the
 * interval between `metered_through` and now, both of which are rows in this database. Nothing here
 * consults a vendor billing API. That is ADR 0014's rule — money never rides the telemetry path —
 * and it also means a provider outage cannot silently stop the meter.
 */
export const meterSandboxes: JobHandler = async (_job, { db }) => {
  const due = await db
    .selectFrom("sandbox")
    .select("id")
    .where("sandbox.state", "in", ["starting", "running", "idle", "stopped", "deleting"])
    // `starting` begins before Daytona creates anything. Until it returns an id there is no
    // provider object consuming resources, regardless of how long this row has waited in a queue.
    .where("sandbox.externalId", "is not", null)
    // Every concurrent sweep takes row locks in the same order, so two multi-sandbox sweeps cannot
    // deadlock by each holding the row the other plans to claim next.
    .orderBy("id")
    .execute()

  let metered = 0

  for (const candidate of due) {
    /*
      The row lock is the claim on this interval.

      Two schedulers can select the same candidate before either advances its watermark. Reading the
      authoritative watermark only after `FOR UPDATE` makes the second transaction wait, then see
      the first one's new endpoint. Locking only `sandbox` matters: locking the joined project row
      would unnecessarily serialize every sandbox belonging to one project.
    */
    const didMeter = await db.transaction().execute(async (tx) => {
      const sandbox = await tx
        .selectFrom("sandbox")
        .innerJoin("project", "project.id", "sandbox.projectId")
        .select([
          "sandbox.id",
          "sandbox.projectId",
          "sandbox.state",
          "sandbox.cpu",
          "sandbox.memoryGib",
          "sandbox.diskGib",
          "sandbox.alwaysOn",
          "sandbox.idleTimeoutS",
          "sandbox.lastActivityAt",
          "sandbox.meteredThrough",
          "sandbox.createdAt",
          "project.organizationId",
        ])
        .where("sandbox.id", "=", candidate.id)
        .where("sandbox.state", "in", ["starting", "running", "idle", "stopped", "deleting"])
        // Re-check under the row lock: provider-loss recovery can clear the id after the outer
        // sweep selected this candidate.
        .where("sandbox.externalId", "is not", null)
        .forUpdate("sandbox")
        .executeTakeFirst()
      if (sandbox === undefined) return false

      /*
        The database's clock, taken after the lock.

        `created_at` and `metered_through` are both written by Postgres, so an interval measured
        against `new Date()` is a subtraction across two clocks. `clock_timestamp()` rather than
        `now()` is important here: Postgres fixes `now()` at transaction start, which may be before
        a concurrent meter whose row lock this transaction just waited for.
      */
      const clock = await sql<{ now: Date }>`select clock_timestamp() as now`.execute(tx)
      const databaseNow = clock.rows[0]?.now
      if (databaseNow === undefined) throw new Error("Postgres returned no clock timestamp")
      // Daytona's provider backstop stops an ordinary sandbox at this same idle deadline. If its
      // webhook/reconciliation arrives late, billing to the sweep time would charge for a machine
      // the provider had already stopped. `always_on` is the only class without that ceiling.
      const idleDeadline = new Date(
        new Date(sandbox.lastActivityAt).getTime() + sandbox.idleTimeoutS * 1000,
      )
      const computeThrough =
        sandbox.state === "stopped"
          ? new Date(sandbox.meteredThrough ?? sandbox.createdAt)
          : sandbox.alwaysOn || databaseNow <= idleDeadline
            ? databaseNow
            : idleDeadline

      // Null means never metered. `created_at`, not the epoch — the difference is forty years of
      // compute nobody ran.
      const from = sandbox.meteredThrough ?? sandbox.createdAt
      const diskSeconds = (databaseNow.getTime() - new Date(from).getTime()) / 1000
      // A clock that went backwards, or a row metered in the same millisecond twice. Neither is
      // billable.
      if (diskSeconds <= 0) return false

      const computeSeconds = Math.max(
        0,
        (computeThrough.getTime() - new Date(from).getTime()) / 1000,
      )

      const quantities: Record<keyof typeof DIMENSIONS, number> = {
        cpu: computeSeconds * sandbox.cpu,
        memoryGib: computeSeconds * sandbox.memoryGib,
        diskGib: diskSeconds * sandbox.diskGib,
      }

      const outbox = crudMeteringOutbox(tx)
      await Promise.all(
        (Object.keys(DIMENSIONS) as (keyof typeof DIMENSIONS)[]).map(async (key) => {
          if (quantities[key] <= 0) return
          const through = key === "diskGib" ? databaseNow : computeThrough
          const event = usageEventRecord({
            source: "sandbox",
            /*
              Keyed on the interval **and the dimension**.

              Without the dimension all three rows have the same source identity, so the outbox's
              unique event id silently drops two of them. The customer is billed for CPU and not
              for memory or disk, every row inserts without error, and the only evidence is a bill
              that is a third of what it should be. Caught by `sandbox.test.ts` asserting all three
              dimensions land, which is why that test lists them rather than counting.
            */
            externalId: `${sandbox.id}:${DIMENSIONS[key]}:${new Date(from).toISOString()}`,
            organizationId: sandbox.organizationId,
            projectId: sandbox.projectId,
            resourceType: "sandbox",
            resourceId: sandbox.id,
            dimension: DIMENSIONS[key],
            quantity: quantities[key].toString(),
            occurredAt: through,
            windowStart: new Date(from),
            windowEnd: through,
            nodeId: null,
            podUid: null,
            chargedExternally: false,
            attributes: {},
          })
          await outbox.create({
            id: v7(),
            eventId: event.eventId,
            payload: JSON.parse(encodeUsageEvent(event)) as JsonValue,
          })
        }),
      )

      await tx
        .updateTable("sandbox")
        .set({ meteredThrough: databaseNow })
        .where("id", "=", sandbox.id)
        .execute()

      return true
    })

    if (didMeter) metered += 1
  }

  if (metered > 0) console.info(`[jobs] metered ${metered} sandboxes`)
}

/**
 * Stop sandboxes nobody is using.
 *
 * `fetchSandbox(db).idle()` is the whole query and it already honours `always_on` — a caller that
 * forgets it stops a customer's long-running environment, and the symptom is "it keeps dying" with
 * no error anywhere. Enqueued one job per sandbox rather than stopped inline: stopping talks to the
 * provider, and one unreachable sandbox must not leave the rest running.
 */
export const reapSandboxes: JobHandler = async (_job, { db }) => {
  const idle = await fetchSandbox(db).idle()

  for (const sandbox of idle) {
    await enqueue(db, {
      kind: SANDBOX_KINDS.stop,
      organizationId: null,
      payload: { sandboxId: sandbox.id },
      // One stop per sandbox per minute at most, however often the reaper runs.
      idempotencyKey: `${SANDBOX_KINDS.stop}:${sandbox.id}:${new Date().toISOString().slice(0, 16)}`,
      maxAttempts: 3,
    })
  }

  if (idle.length > 0) console.info(`[jobs] reaping ${idle.length} idle sandboxes`)
}

/** Repair provider-driven state changes before the database can keep metering a stopped machine. */
export function reconcileSandboxes(
  makeDriver: () => DaytonaSandboxClient = daytona,
  drop: typeof dropDevBranch = dropDevBranch,
  branchConfig: typeof neonPostgresConfigFromEnv = neonPostgresConfigFromEnv,
): JobHandler {
  return async (job, context) => {
    const candidates = await context.db
      .selectFrom("sandbox")
      .select(["id", "externalId"])
      // A stopped Daytona object still incurs reserved-disk cost until the provider archives or
      // deletes it. Keep observing stopped joins so provider loss clears both billing and branches.
      .where("state", "in", ["starting", "running", "idle", "stopped"])
      .where("externalId", "is not", null)
      .execute()

    if (candidates.length === 0) return

    // Settle active intervals first. The meter caps ordinary sandboxes at their idle deadline, so
    // a delayed observation cannot charge past Daytona's own auto-stop boundary.
    await meterSandboxes(job, context)
    const sandboxDriver = makeDriver()

    for (const candidate of candidates) {
      try {
        const providerState = await sandboxDriver.state(candidate.externalId!)
        if (["stopped", "archived", "paused"].includes(providerState)) {
          await crudSandbox(context.db).updateIfState(
            candidate.id,
            ["starting", "running", "idle", "stopped"],
            { state: "stopped" },
          )
        } else if (providerState === "destroyed") {
          await cleanMissingProviderObject(
            context.db,
            { sandboxId: candidate.id, externalId: candidate.externalId! },
            drop,
            branchConfig,
          )
        } else if (["error", "build_failed"].includes(providerState)) {
          await crudSandbox(context.db).updateIfState(
            candidate.id,
            ["starting", "running", "idle", "stopped"],
            { state: "failed" },
          )
        }
      } catch (error) {
        if (error instanceof SandboxNotFoundError) {
          try {
            await cleanMissingProviderObject(
              context.db,
              { sandboxId: candidate.id, externalId: candidate.externalId! },
              drop,
              branchConfig,
            )
          } catch (cleanupError) {
            // The shared cleanup marks the row failed before touching Neon. Failed is non-metered,
            // and the sandbox reaper gives it fresh stop jobs until cleanup finishes.
            console.error(
              `[jobs] failed to clean missing sandbox ${candidate.id}: ${String(cleanupError)}`,
            )
          }
          continue
        }
        // One provider object must not prevent every other row from reconciling. The recurring job
        // retries next minute, while this error remains visible to operations.
        console.error(`[jobs] failed to reconcile sandbox ${candidate.id}: ${String(error)}`)
      }
    }
  }
}

/**
 * Put a checkout, an identity and the platform's instructions into a fresh sandbox.
 *
 * Returns what went wrong rather than throwing, for the reason at the call site: a partially
 * bootstrapped sandbox is still worth having, and a provision that fails because a file did not
 * write tells the customer to retry something that was not their problem.
 *
 * The GitHub App installation, not the user's OAuth token. An installation token is scoped to the
 * repositories the customer granted and expires in an hour; a user token is scoped to everything
 * that user can reach, for as long as it lives, and would be sitting inside a machine a model runs
 * commands on.
 */
async function bootstrap(
  db: Kysely<DB>,
  sandboxDriver: DaytonaSandboxClient,
  input: { externalId: string; organizationId: string; projectId: string; userId: string },
): Promise<string[]> {
  try {
    const project = await db
      .selectFrom("project")
      .innerJoin("repository", "repository.id", "project.repositoryId")
      .select([
        "project.slug as slug",
        "project.productionBranch as branch",
        "repository.id as repositoryId",
        "repository.githubRepoId as githubRepoId",
        "repository.ownerLogin as owner",
        "repository.name as name",
      ])
      .where("project.id", "=", input.projectId)
      .executeTakeFirst()
    if (project === undefined) return ["the project disappeared before the sandbox was ready"]

    /* The exact installation linked to this repository; another installation is not authority. */
    const installation = await fetchGithubInstallation(db).getForRepository(
      input.organizationId,
      project.repositoryId,
      ["installationId"],
    )
    if (installation === undefined) {
      // Not a failure of the sandbox. Said plainly because "the agent cannot see your code" has a
      // cause the customer can act on, and a generic bootstrap error does not.
      return [
        "this organization has no GitHub App installation, so the repository could not be cloned",
      ]
    }

    const tokens = createInstallationTokenStore({
      client: createGitHubClient(),
      signJwt: envAppJwtSigner(),
    })
    /*
      `installation_id` is `int8`, which Kysely surfaces as a string.

      Coerced here rather than left to `Number()` at some later call site: GitHub's ids are well
      inside the safe range, and the alternative is a token request against `/app/installations/
      [object Object]` — a 404 that reads like an uninstalled App.
    */
    const token = await tokens.get(Number(installation.installationId), {
      purpose: "sandbox-clone",
      repositoryId: Number(project.githubRepoId),
    })

    const user = await db
      .selectFrom("user")
      .select(["email", "name"])
      .where("id", "=", input.userId)
      .executeTakeFirst()

    const credential = await resolveAgentCredential(db, input.organizationId)
    const harness = credential.billing === "byo" ? harnessFor(credential.kind) : ("codex" as const)

    const result = await bootstrapSandbox({
      author: {
        /*
          The customer's own identity, so the history reads as theirs with a co-author trailer
          rather than as a robot's. A commit attributed to the platform is one a customer cannot
          find when they search their own history.
        */
        email: user?.email ?? "agent@sproutos.me",
        name: user?.name ?? "SproutOS Agent",
      },
      driver: sandboxDriver,
      externalId: input.externalId,
      harness,
      model: credential.billing === "none" ? null : credential.model,
      proxyBaseUrl: process.env.LLM_PROXY_URL ?? "https://llm.sproutos.me",
      repository: {
        branch: project.branch,
        fullName: `${project.owner}/${project.name}`,
        token: token.token,
      },
      skill: renderSproutosSkill({
        apiUrl: process.env.NEXT_PUBLIC_API_URL ?? "https://api.sproutos.me",
        projectSlug: project.slug,
        tenantDomain: process.env.TENANT_DOMAIN ?? "sproutos.run",
        workspacePath: sandboxDriver.workspaceDir,
      }),
    })

    return result.problems
  } catch (cause) {
    return [String(cause)]
  }
}

/**
 * The dev database a sandbox works against, and the environment variable that names it.
 *
 * A coding agent with a checkout and no database can read code and cannot run it: no dev server, no
 * migration, no test that touches a row. This branches the project's Postgres — copy-on-write, so a
 * copy of a hundred gigabytes is instant and costs only what the agent changes — and hands back a
 * `DATABASE_URL` pointing at `pg-proxy` with a credential that can reach the branch and nothing
 * else. Production is one connection away and unreachable, which is the point.
 *
 * Returns nothing rather than throwing when the project has no database. Most projects do not, and
 * a sandbox without one is the normal case, not a failure.
 *
 * The service is looked up for the *group* as well as the project: a group holds the databases its
 * children share, and a sandbox is scoped to the group — see `sandboxScopeFor`.
 */
async function devDatabase(
  db: Kysely<DB>,
  input: { projectId: string; organizationId: string; sandboxId: string },
): Promise<{ env: Record<string, string>; databaseBranchId: string } | undefined> {
  const serviceId = await fetchSandbox(db).postgresServiceIdForScope(input.projectId)

  if (serviceId === undefined) return undefined

  try {
    const branch = await createDevBranch(db, neonPostgresConfigFromEnv(), {
      backendServiceId: serviceId,
      organizationId: input.organizationId,
      label: "default",
      maxOwnedBranches: MAX_SANDBOX_DATABASE_BRANCHES,
      ownerSandboxId: input.sandboxId,
    })
    return { databaseBranchId: branch.databaseBranchId, env: { DATABASE_URL: branch.uri } }
  } catch (cause) {
    /*
      A sandbox with no dev database is worth having; a provision that failed because Neon was busy
      is not. Logged rather than raised, and the sandbox comes up without `DATABASE_URL` — which the
      agent discovers immediately and can say, instead of the customer waiting for a container that
      never arrives.
    */
    console.warn(`[jobs] sandbox ${input.sandboxId} has no dev database: ${String(cause)}`)
    return undefined
  }
}

/**
 * Resolve the Postgres service visible to a sandbox's project scope.
 *
 * A sandbox belongs to the top-level group (`sandboxScopeFor`), while services remain attached to
 * the deployable child that created them. Resolve the selected project first, its parent group
 * second, and its children last. The last case is the production group topology; omitting it makes
 * a group sandbox silently start without the database shown beneath that group in the UI.
 */
export async function findSandboxPostgresServiceId(
  db: Kysely<DB>,
  projectId: string,
): Promise<string | undefined> {
  return await fetchSandbox(db).postgresServiceIdForScope(projectId)
}

type SandboxPayload = { sandboxId?: string }

function daytona(): DaytonaSandboxClient {
  return daytonaClientFromEnv()
}

/** Remove the stale Daytona join and every branch; replacement requires a new user request. */
async function cleanMissingProviderObject(
  db: Kysely<DB>,
  input: { sandboxId: string; externalId: string },
  drop: typeof dropDevBranch,
  branchConfig: typeof neonPostgresConfigFromEnv,
): Promise<boolean> {
  const current = await db
    .selectFrom("sandbox")
    .select(["externalId", "state", "databaseBranchId"])
    .where("id", "=", input.sandboxId)
    .executeTakeFirst()
  if (
    current === undefined ||
    current.externalId !== input.externalId ||
    !["starting", "running", "idle", "stopped", "failed"].includes(current.state)
  ) {
    return false
  }

  // Provider absence is authoritative. Persist it before any Neon call so a crash or provider
  // outage cannot leave phantom CPU/memory/disk billing. `failed` is picked up by reapSandboxes,
  // whose fresh stop jobs retry this same cleanup, but is deliberately excluded from metering.
  const missing = await db
    .updateTable("sandbox")
    .set({ state: "failed", updatedAt: new Date() })
    .where("id", "=", input.sandboxId)
    .where("externalId", "=", input.externalId)
    .where("state", "in", ["starting", "running", "idle", "stopped", "failed"])
    .returning(["databaseBranchId"])
    .executeTakeFirst()
  if (missing === undefined) return false

  /*
      The branch credential exists only inside the missing container. Its secret is intentionally
      stored as a one-way hash, so a replacement cannot reuse it. Drop the branch before severing
      the row's reference; otherwise every provider-side disappearance leaves a paid Neon branch
      with no sandbox pointing at it. The protected-primary check in `dropDevBranch` is the final
      guard if this foreign key is ever wrong.
    */
  const ownedBranches = await fetchSandboxDatabaseBranch(db).listForSandbox(input.sandboxId)
  const branchIds = new Set(ownedBranches.map((owned) => owned.databaseBranchId))
  if (missing.databaseBranchId !== null) branchIds.add(missing.databaseBranchId)
  const cleanupFailures: unknown[] = []
  for (const databaseBranchId of branchIds) {
    try {
      await drop(db, branchConfig(), databaseBranchId)
    } catch (error) {
      try {
        await crudDatabaseBranch(db).deferCleanup(databaseBranchId, error)
        cleanupFailures.push(error)
      } catch (deferError) {
        cleanupFailures.push(
          new AggregateError(
            [error, deferError],
            `branch ${databaseBranchId} failed cleanup and retry deferral`,
            { cause: error },
          ),
        )
      }
    }
  }
  if (cleanupFailures.length > 0) {
    throw new AggregateError(
      cleanupFailures,
      `${cleanupFailures.length} branch cleanup attempt(s) failed for missing sandbox ${input.sandboxId}`,
    )
  }

  const cleaned = await db
    .updateTable("sandbox")
    .set({
      externalId: null,
      databaseBranchId: null,
      state: "stopped",
      lastActivityAt: sql<Date>`now()` as unknown as Date,
      updatedAt: new Date(),
    })
    .where("id", "=", input.sandboxId)
    .where("externalId", "=", input.externalId)
    .where("state", "in", ["starting", "running", "idle", "stopped", "failed"])
    .executeTakeFirst()
  return Number(cleaned.numUpdatedRows) === 1
}

/** Create the sandbox at the provider and record what it gave back. */
export function provisionSandbox(
  makeDriver: () => DaytonaSandboxClient = daytona,
  drop: typeof dropDevBranch = dropDevBranch,
  branchConfig: typeof neonPostgresConfigFromEnv = neonPostgresConfigFromEnv,
): JobHandler {
  return async (job, { db }) => {
    const { sandboxId } = job.payload as SandboxPayload
    if (sandboxId === undefined) throw new Error(`${job.kind} needs a sandboxId`)

    const sandbox = await db
      .selectFrom("sandbox")
      .innerJoin("project", "project.id", "sandbox.projectId")
      .select([
        "sandbox.id",
        "sandbox.projectId",
        "sandbox.userId",
        "sandbox.sandboxClass",
        "sandbox.cpu",
        "sandbox.memoryGib",
        "sandbox.diskGib",
        "sandbox.idleTimeoutS",
        "sandbox.alwaysOn",
        "sandbox.externalId",
        "sandbox.state",
        "project.organizationId",
      ])
      .where("sandbox.id", "=", sandboxId)
      .executeTakeFirst()

    // Deleted between enqueue and claim. Nothing to provision and nothing to report.
    if (sandbox === undefined) return

    if (
      sandbox.state === "running" ||
      sandbox.state === "idle" ||
      sandbox.state === "stopped" ||
      sandbox.state === "deleting"
    ) {
      return
    }

    /*
      The worker marks a failed attempt `failed` before asking the queue to retry it. The forward
      proxy rejects failed sandboxes by design, so retrying bootstrap in that state guarantees that
      clone and every package-manager request receive 407 forever. Re-enter the same `starting`
      state the request path used before touching Daytona. A conditional update also makes a second,
      distinct provision job stand down if another worker already moved this row.
    */
    if (sandbox.state === "failed") {
      const retrying = await crudSandbox(db).updateIfState(sandbox.id, ["failed"], {
        state: "starting",
        lastActivityAt: sql<Date>`now()` as unknown as Date,
      })
      if (retrying === undefined) return
    }

    let sandboxDriver: DaytonaSandboxClient | undefined
    let providerExternalId = sandbox.externalId
    let unrecordedDatabaseBranchId: string | undefined
    try {
      sandboxDriver = makeDriver()

      /*
        Already created at the provider, but not necessarily bootstrapped.

        A job whose lease expired mid-create is retried, and the provider may well have created the
        sandbox before we lost the response. Creating a second one would leave the first running,
        unreferenced and billing — the unique index on `(provider, external_id)` prevents the row,
        not the container. Finish bootstrap against the recorded object and only then expose it as
        `running`; the UI treats that state as permission to send a turn immediately.
      */
      if (sandbox.externalId !== null) {
        const providerState = await sandboxDriver.state(sandbox.externalId)
        if (!["started", "running"].includes(providerState)) {
          await sandboxDriver.start(sandbox.externalId)
        }
        const current = await db
          .selectFrom("sandbox")
          .select("state")
          .where("id", "=", sandbox.id)
          .executeTakeFirst()
        if (current === undefined || current.state === "deleting") {
          await sandboxDriver.destroy(sandbox.externalId)
          return
        }
        const problems = await bootstrap(db, sandboxDriver, {
          externalId: sandbox.externalId,
          organizationId: sandbox.organizationId,
          projectId: sandbox.projectId,
          userId: sandbox.userId,
        })
        if (problems.length > 0) throw new SandboxBootstrapError(sandbox.id, problems)
        await crudSandbox(db).updateIfState(sandbox.id, ["starting", "failed"], {
          state: "running",
        })
        return
      }

      /*
        The branch is created before the container, because it is the part that can fail.

        A container that comes up and then finds it has no database has already cost the customer
        the wait; a branch that fails while nothing has been created costs a log line. The reverse
        order also leaks: a create that succeeds and a branch that throws leaves a running sandbox
        nobody recorded.
      */
      const database = await devDatabase(db, {
        organizationId: sandbox.organizationId,
        projectId: sandbox.projectId,
        sandboxId: sandbox.id,
      })
      unrecordedDatabaseBranchId = database?.databaseBranchId

      const created = await sandboxDriver.create({
        sandboxId: sandbox.id,
        organizationId: sandbox.organizationId,
        projectId: sandbox.projectId,
        userId: sandbox.userId,
        sandboxClass: sandbox.sandboxClass === "android" ? "android" : "container",
        resources: {
          cpu: sandbox.cpu,
          memoryGib: sandbox.memoryGib,
          diskGib: sandbox.diskGib,
        },
        idleTimeoutS: sandbox.idleTimeoutS,
        alwaysOn: sandbox.alwaysOn,
        ...(database === undefined ? {} : { env: database.env }),
      })
      providerExternalId = created.externalId

      const recorded = await crudSandbox(db).updateIfState(sandbox.id, ["starting", "failed"], {
        externalId: created.externalId,
        ...(database === undefined ? {} : { databaseBranchId: database.databaseBranchId }),
        // The meter starts when the sandbox does, not when the row was inserted — a create that
        // queued behind other work should not bill for the wait.
        meteredThrough: sql<Date>`now()` as unknown as Date,
        lastActivityAt: sql<Date>`now()` as unknown as Date,
      })
      if (recorded === undefined) {
        await sandboxDriver.destroy(created.externalId)
        if (database !== undefined) {
          await dropDevBranch(db, neonPostgresConfigFromEnv(), database.databaseBranchId)
        }
        return
      }
      unrecordedDatabaseBranchId = undefined

      /*
        A sandbox with nothing in it is a sandbox nobody can work in.

        Until now `create` was the whole job: the container came up empty — no checkout, no git
        identity, no instructions — and every route that followed assumed a workspace that had never
        been put there. Bootstrapping here rather than on first use means the cost is paid while the
        customer is already waiting for the sandbox to start, instead of in the middle of their
        first message.

        Every reported problem fails the job. Publishing `running` after clone or file setup failed
        would send the first turn into an empty or partial workspace while claiming bootstrap had
        completed. The catch below stops the provider before it publishes `failed`.
      */
      const problems = await bootstrap(db, sandboxDriver, {
        externalId: created.externalId,
        organizationId: sandbox.organizationId,
        projectId: sandbox.projectId,
        userId: sandbox.userId,
      })
      if (problems.length > 0) throw new SandboxBootstrapError(sandbox.id, problems)
      await crudSandbox(db).updateIfState(sandbox.id, ["starting", "failed"], {
        state: "running",
      })
    } catch (error) {
      if (
        error instanceof SandboxNotFoundError &&
        providerExternalId !== null &&
        (await cleanMissingProviderObject(
          db,
          {
            sandboxId: sandbox.id,
            externalId: providerExternalId,
          },
          drop,
          branchConfig,
        ))
      ) {
        return
      }

      let cleanupError: unknown
      if (sandboxDriver !== undefined && providerExternalId !== null) {
        try {
          await sandboxDriver.stop(providerExternalId)
        } catch (cause) {
          if (!(cause instanceof SandboxNotFoundError)) cleanupError = cause
        }
      }
      if (unrecordedDatabaseBranchId !== undefined) {
        try {
          await dropDevBranch(db, neonPostgresConfigFromEnv(), unrecordedDatabaseBranchId)
        } catch (cause) {
          cleanupError =
            cleanupError === undefined
              ? cause
              : new AggregateError(
                  [cleanupError, cause],
                  `sandbox ${sandbox.id} provider and database cleanup both failed`,
                )
        }
      }
      await crudSandbox(db).updateIfState(sandbox.id, ["starting", "failed"], { state: "failed" })
      if (cleanupError !== undefined) {
        throw new AggregateError(
          [error, cleanupError],
          `sandbox ${sandbox.id} failed and its provider cleanup also failed`,
          { cause: error },
        )
      }
      throw error
    }
  }
}

export class SandboxBootstrapError extends Error {
  override readonly name = "SandboxBootstrapError"

  constructor(
    readonly sandboxId: string,
    readonly problems: readonly string[],
  ) {
    super(`sandbox ${sandboxId} could not be bootstrapped: ${problems.join("; ")}`)
  }
}

/** Start a stopped provider sandbox without replacing its persistent workspace. */
export function startSandbox(
  makeDriver: () => DaytonaSandboxClient = daytona,
  drop: typeof dropDevBranch = dropDevBranch,
  branchConfig: typeof neonPostgresConfigFromEnv = neonPostgresConfigFromEnv,
): JobHandler {
  return async (job, { db }) => {
    const { sandboxId } = job.payload as SandboxPayload
    if (sandboxId === undefined) throw new Error(`${job.kind} needs a sandboxId`)

    const sandbox = await db
      .selectFrom("sandbox")
      .innerJoin("project", "project.id", "sandbox.projectId")
      .select(["sandbox.id", "sandbox.externalId", "sandbox.state", "project.organizationId"])
      .where("sandbox.id", "=", sandboxId)
      .executeTakeFirst()

    if (
      sandbox === undefined ||
      sandbox.state === "running" ||
      sandbox.state === "idle" ||
      sandbox.state === "stopped" ||
      sandbox.state === "deleting"
    ) {
      return
    }
    if (sandbox.externalId === null) {
      await crudSandbox(db).updateIfState(sandbox.id, ["starting", "failed"], { state: "failed" })
      throw new Error(`sandbox ${sandbox.id} has no provider id to start`)
    }

    try {
      const sandboxDriver = makeDriver()
      await sandboxDriver.start(sandbox.externalId)
      const running = await crudSandbox(db).updateIfState(sandbox.id, ["starting", "failed"], {
        state: "running",
        // A stopped interval is not billable. Restarting begins a new interval at Postgres's clock.
        meteredThrough: sql<Date>`now()` as unknown as Date,
        lastActivityAt: sql<Date>`now()` as unknown as Date,
      })
      if (running === undefined) {
        const current = await db
          .selectFrom("sandbox")
          .select("state")
          .where("id", "=", sandbox.id)
          .executeTakeFirst()
        if (current === undefined || current.state === "deleting") {
          await sandboxDriver.destroy(sandbox.externalId)
        }
      }
    } catch (error) {
      if (error instanceof SandboxNotFoundError) {
        /*
          A stopped row can outlive Daytona's provider object.

          Daytona auto-archives stopped sandboxes and the reaper also treats an already-missing
          object as stopped. Starting that stale id can never succeed: retrying the same start job
          only turns `starting` into `failed`, after which the reaper writes `stopped` again and
          the next request repeats the loop. Clear the stale join and its branch credentials, then
          leave the row stopped. Provisioning here would rent a replacement without a new user
          request; `requestSandboxStart` is the only path allowed to do that.
        */
        await cleanMissingProviderObject(
          db,
          {
            sandboxId: sandbox.id,
            externalId: sandbox.externalId,
          },
          drop,
          branchConfig,
        )
        return
      }

      const failed = await crudSandbox(db).updateIfState(sandbox.id, ["starting", "failed"], {
        state: "failed",
      })
      if (failed === undefined) {
        const current = await db
          .selectFrom("sandbox")
          .select("state")
          .where("id", "=", sandbox.id)
          .executeTakeFirst()
        if (current?.state === "running") return
      }
      throw error
    }
  }
}

/** Stop at the provider, settle the tail, leave the workspace. */
export function stopSandbox(
  makeDriver: () => DaytonaSandboxClient = daytona,
  drop: typeof dropDevBranch = dropDevBranch,
  branchConfig: typeof neonPostgresConfigFromEnv = neonPostgresConfigFromEnv,
): JobHandler {
  return async (job, context) => {
    const { sandboxId } = job.payload as SandboxPayload
    if (sandboxId === undefined) throw new Error(`${job.kind} needs a sandboxId`)
    const { db } = context

    const sandbox = await db
      .selectFrom("sandbox")
      .select(["id", "externalId", "state"])
      .where("id", "=", sandboxId)
      .executeTakeFirst()

    if (sandbox === undefined || sandbox.state === "stopped" || sandbox.state === "deleting") return

    /*
      Meter before stopping, not after.

      `meterSandboxes` only looks at rows whose state says they are running, so the moment this
      writes `stopped` the tail between the last run and now becomes unbillable — and unlike a
      failed insert, nothing is left to notice it. Metering everything is cheap and idempotent.
    */
    await meterSandboxes(job, context)

    if (sandbox.externalId !== null) {
      try {
        await makeDriver().stop(sandbox.externalId)
      } catch (error) {
        if (!(error instanceof SandboxNotFoundError)) throw error
        await cleanMissingProviderObject(
          db,
          { sandboxId: sandbox.id, externalId: sandbox.externalId },
          drop,
          branchConfig,
        )
        return
      }
    }

    await crudSandbox(db).updateIfState(sandbox.id, ["starting", "running", "idle", "failed"], {
      state: "stopped",
    })
  }
}

/** Destroy at the provider, then drop the row. Order matters — see `teardown.ts`. */
export function destroySandbox(
  makeDriver: () => DaytonaSandboxClient = daytona,
  drop: typeof dropDevBranch = dropDevBranch,
  branchConfig: typeof neonPostgresConfigFromEnv = neonPostgresConfigFromEnv,
): JobHandler {
  return async (job, context) => {
    const { sandboxId } = job.payload as SandboxPayload
    if (sandboxId === undefined) throw new Error(`${job.kind} needs a sandboxId`)
    const { db } = context

    const sandbox = await db
      .selectFrom("sandbox")
      .select(["id", "externalId", "databaseBranchId"])
      .where("id", "=", sandboxId)
      .executeTakeFirst()

    if (sandbox === undefined) return

    await meterSandboxes(job, context)

    if (sandbox.externalId !== null) {
      try {
        await makeDriver().destroy(sandbox.externalId)
      } catch (error) {
        if (!(error instanceof SandboxNotFoundError)) throw error
      }
    }

    /*
      The dev branch goes with the sandbox.

      A branch outlives the row that points at it unless something deletes it, and then it is
      storage nobody is looking at, on a bill nobody can attribute — the same shape as the orphaned
      sandbox the unique index does not prevent. `dropDevBranch` refuses a protected branch, so the
      worst case of a wrong id here is a failed job rather than a deleted production database.

      Failing the job on error is deliberate. Dropping the row while the branch survives is exactly
      how the reference is lost.
    */
    const ownedBranches = await fetchSandboxDatabaseBranch(db).listForSandbox(sandbox.id)
    const branchIds = new Set(ownedBranches.map((owned) => owned.databaseBranchId))
    if (sandbox.databaseBranchId !== null) branchIds.add(sandbox.databaseBranchId)
    const cleanupFailures: unknown[] = []
    for (const databaseBranchId of branchIds) {
      try {
        await drop(db, branchConfig(), databaseBranchId)
      } catch (error) {
        cleanupFailures.push(error)
      }
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        cleanupFailures,
        `${cleanupFailures.length} branch cleanup attempt(s) failed for sandbox ${sandbox.id}`,
      )
    }

    await crudSandbox(db).remove(sandbox.id)
  }
}

export function reapExpiredDatabaseBranches(
  drop: typeof dropDevBranch = dropDevBranch,
  branchConfig: typeof neonPostgresConfigFromEnv = neonPostgresConfigFromEnv,
): JobHandler {
  return async (_job, { db }) => {
    const expired = await fetchDatabaseBranch(db).expiredUnprotected(
      new Date(),
      DATABASE_BRANCH_REAP_BATCH_SIZE,
    )
    const failures: unknown[] = []
    for (const branch of expired) {
      try {
        await drop(db, branchConfig(), branch.id)
      } catch (error) {
        try {
          await crudDatabaseBranch(db).deferCleanup(branch.id, error)
          failures.push(error)
        } catch (deferError) {
          failures.push(
            new AggregateError(
              [error, deferError],
              `branch ${branch.id} failed cleanup and retry deferral`,
              { cause: error },
            ),
          )
        }
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `${failures.length} expired database branch cleanup attempt(s) failed`,
      )
    }
  }
}

/** Requeue deletion with a fresh key even when an older destroy job is terminal. */
export const repairDeletingSandboxes: JobHandler = async (_job, { db }) => {
  const minute = new Date().toISOString().slice(0, 16)
  const deleting = await db
    .selectFrom("sandbox")
    .innerJoin("project", "project.id", "sandbox.projectId")
    .select(["sandbox.id", "project.organizationId"])
    .where("sandbox.state", "=", "deleting")
    .orderBy("sandbox.updatedAt", "asc")
    .limit(100)
    .execute()
  for (const sandbox of deleting) {
    await enqueue(db, {
      kind: SANDBOX_KINDS.destroy,
      organizationId: sandbox.organizationId,
      payload: { sandboxId: sandbox.id },
      idempotencyKey: `${SANDBOX_KINDS.destroy}:${sandbox.id}:repair:${minute}`,
      maxAttempts: 3,
    })
  }
}

/**
 * Keep metering, reconciliation, idle/branch reaping, and destroy repair scheduled.
 *
 * Both key on the minute rather than the ten-minute window the billing jobs use. A sandbox is
 * billed by the second and reaped on a fifteen-minute idle timer, so ten minutes of slack is most
 * of the timer — and the cost of running these more often is one indexed query returning nothing.
 */
export async function scheduleSandboxJobs(db: Kysely<DB>, now: Date = new Date()): Promise<void> {
  const minute = now.toISOString().slice(0, 16)

  await enqueue(db, {
    kind: SANDBOX_KINDS.meter,
    idempotencyKey: `${SANDBOX_KINDS.meter}:${minute}`,
    maxAttempts: 3,
  })
  await enqueue(db, {
    kind: SANDBOX_KINDS.reconcile,
    idempotencyKey: `${SANDBOX_KINDS.reconcile}:${minute}`,
    maxAttempts: 3,
  })
  await enqueue(db, {
    kind: SANDBOX_KINDS.reap,
    idempotencyKey: `${SANDBOX_KINDS.reap}:${minute}`,
    maxAttempts: 3,
  })
  await enqueue(db, {
    kind: SANDBOX_KINDS.reapDatabaseBranches,
    idempotencyKey: `${SANDBOX_KINDS.reapDatabaseBranches}:${minute}`,
    maxAttempts: 5,
  })
  await enqueue(db, {
    kind: SANDBOX_KINDS.repairDestroy,
    idempotencyKey: `${SANDBOX_KINDS.repairDestroy}:${minute}`,
    maxAttempts: 3,
  })
}
