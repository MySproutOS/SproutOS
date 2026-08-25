import { crudSandbox, fetchSandbox } from "@lib/dao"
import { daytonaConfigFromEnv, daytonaDriver, SandboxNotFoundError } from "@lib/sandbox"
import type { SandboxDriver } from "@lib/sandbox"
import type { DB } from "@sproutos/db"
import { sql, type Kysely } from "kysely"
import { v7 } from "uuid"
import { enqueue } from "./queue"
import type { JobHandler } from "./worker"

export const SANDBOX_KINDS = {
  provision: "sandbox.provision",
  stop: "sandbox.stop",
  destroy: "sandbox.destroy",
  reap: "sandbox.reap",
  meter: "sandbox.meter",
} as const

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
} as const

/**
 * Meter every running sandbox up to now.
 *
 * **Not only at stop.** A stop that never completes — a crashed worker, a provider timeout, a
 * sandbox someone forgets — would otherwise be free compute for as long as it runs, and free
 * compute has no error state. So the bill accrues on a schedule and stopping settles the tail.
 *
 * Quantity comes from our own numbers: the resource shape we asked the provider for, and the
 * interval between `metered_through` and now, both of which are rows in this database. Nothing here
 * consults a vendor billing API. That is ADR 0014's rule — money never rides the telemetry path —
 * and it also means a provider outage cannot silently stop the meter.
 */
export const meterSandboxes: JobHandler = async (_job, { db }) => {
  const now = new Date()

  const due = await db
    .selectFrom("sandbox")
    .innerJoin("project", "project.id", "sandbox.projectId")
    .select([
      "sandbox.id",
      "sandbox.projectId",
      "sandbox.cpu",
      "sandbox.memoryGib",
      "sandbox.diskGib",
      "sandbox.meteredThrough",
      "sandbox.createdAt",
      "project.organizationId",
    ])
    .where("sandbox.state", "in", ["starting", "running", "idle"])
    .execute()

  let metered = 0

  for (const sandbox of due) {
    // Null means never metered. `created_at`, not the epoch — the difference is forty years of
    // compute nobody ran.
    const from = sandbox.meteredThrough ?? sandbox.createdAt
    const seconds = (now.getTime() - new Date(from).getTime()) / 1000
    // A clock that went backwards, or a row metered in the same second twice. Neither is billable.
    if (seconds <= 0) continue

    const quantities: Record<keyof typeof DIMENSIONS, number> = {
      cpu: seconds * sandbox.cpu,
      memoryGib: seconds * sandbox.memoryGib,
      diskGib: seconds * sandbox.diskGib,
    }

    /*
      The interval and the watermark move together.

      If the insert commits and the update does not, the next run meters the same interval again —
      harmless, because `(source, external_id, occurred_at)` drops it. If the update commits and the
      insert does not, that interval is never billed and there is nothing left to notice it. So both
      happen in one transaction, and the failure that survives is the recoverable one.
    */
    await db.transaction().execute(async (tx) => {
      await tx
        .insertInto("usageEvent")
        .values(
          (Object.keys(DIMENSIONS) as (keyof typeof DIMENSIONS)[]).map((key) => ({
            id: v7(),
            source: "sandbox",
            /*
              Keyed on the interval **and the dimension**.

              Without the dimension all three rows share `(source, external_id, occurred_at)`, and
              the conflict clause below — which exists to make retries free — silently drops two of
              them. The customer is billed for CPU and not for memory or disk, every row inserts
              without error, and the only evidence is a bill that is a third of what it should be.
              Caught by `sandbox.test.ts` asserting all three dimensions land, which is why that
              test lists them rather than counting.
            */
            externalId: `${sandbox.id}:${DIMENSIONS[key]}:${new Date(from).toISOString()}`,
            organizationId: sandbox.organizationId,
            projectId: sandbox.projectId,
            resourceType: "sandbox",
            resourceId: sandbox.id,
            dimension: DIMENSIONS[key],
            quantity: quantities[key].toString(),
            occurredAt: now,
            windowStart: new Date(from),
            windowEnd: now,
          })),
        )
        .onConflict((oc) => oc.columns(["source", "externalId", "occurredAt"]).doNothing())
        .execute()

      await tx
        .updateTable("sandbox")
        .set({ meteredThrough: now })
        .where("id", "=", sandbox.id)
        .execute()
    })

    metered += 1
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

type SandboxPayload = { sandboxId?: string }

function driver(): SandboxDriver {
  return daytonaDriver(daytonaConfigFromEnv())
}

/** Create the sandbox at the provider and record what it gave back. */
export function provisionSandbox(makeDriver: () => SandboxDriver = driver): JobHandler {
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
        "sandbox.externalId",
        "project.organizationId",
      ])
      .where("sandbox.id", "=", sandboxId)
      .executeTakeFirst()

    // Deleted between enqueue and claim. Nothing to provision and nothing to report.
    if (sandbox === undefined) return

    /*
      Already provisioned.

      A job whose lease expired mid-create is retried, and the provider may well have created the
      sandbox before we lost the response. Creating a second one would leave the first running,
      unreferenced and billing — the unique index on `(provider, external_id)` prevents the row, not
      the container.
    */
    if (sandbox.externalId !== null) return

    try {
      const created = await makeDriver().create({
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
      })

      await crudSandbox(db).update(sandbox.id, {
        externalId: created.externalId,
        state: "running",
        // The meter starts when the sandbox does, not when the row was inserted — a create that
        // queued behind other work should not bill for the wait.
        meteredThrough: sql<Date>`now()` as unknown as Date,
      })
    } catch (error) {
      await crudSandbox(db).update(sandbox.id, { state: "failed" })
      throw error
    }
  }
}

/** Stop at the provider, settle the tail, leave the workspace. */
export function stopSandbox(makeDriver: () => SandboxDriver = driver): JobHandler {
  return async (job, context) => {
    const { sandboxId } = job.payload as SandboxPayload
    if (sandboxId === undefined) throw new Error(`${job.kind} needs a sandboxId`)
    const { db } = context

    const sandbox = await db
      .selectFrom("sandbox")
      .select(["id", "externalId", "state"])
      .where("id", "=", sandboxId)
      .executeTakeFirst()

    if (sandbox === undefined || sandbox.state === "stopped") return

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
        // Already gone is stopped. Anything else has to fail the job, because the row would
        // otherwise say stopped while the provider goes on billing.
        if (!(error instanceof SandboxNotFoundError)) throw error
      }
    }

    await crudSandbox(db).update(sandbox.id, { state: "stopped" })
  }
}

/** Destroy at the provider, then drop the row. Order matters — see `teardown.ts`. */
export function destroySandbox(makeDriver: () => SandboxDriver = driver): JobHandler {
  return async (job, context) => {
    const { sandboxId } = job.payload as SandboxPayload
    if (sandboxId === undefined) throw new Error(`${job.kind} needs a sandboxId`)
    const { db } = context

    const sandbox = await db
      .selectFrom("sandbox")
      .select(["id", "externalId"])
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

    await crudSandbox(db).remove(sandbox.id)
  }
}

/**
 * Keep the two recurring sandbox jobs scheduled.
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
    kind: SANDBOX_KINDS.reap,
    idempotencyKey: `${SANDBOX_KINDS.reap}:${minute}`,
    maxAttempts: 3,
  })
}
