import { db } from "@sproutos/db"
import { sql } from "kysely"
import { afterAll, describe, expect, it } from "vitest"
import { JOB_KINDS, scheduleRecurring } from "./handlers"

const reachable = await (async () => {
  try {
    await sql`select 1`.execute(db)
    return true
  } catch {
    return false
  }
})()

const TEST_YEAR = "2099"

afterAll(async () => {
  if (!reachable) return
  await db.deleteFrom("backgroundJob").where("idempotencyKey", "like", `%:${TEST_YEAR}-%`).execute()
  await db.destroy()
})

describe.skipIf(!reachable)("metering schedules", () => {
  it("schedules metering and credit projections once per window", async ({ skip }) => {
    if (!reachable) skip()
    const now = new Date(`${TEST_YEAR}-12-31T23:58:45.000Z`)
    const relayKey = `${JOB_KINDS.relayMeteringOutbox}:${now.toISOString().slice(0, 16)}`
    const reconcileUsageKey = `${JOB_KINDS.reconcileActiveUsage}:2099-12-31T23`
    const importKey = `${JOB_KINDS.importUsage}:${now.toISOString().slice(0, 15)}`
    const creditKey = `${JOB_KINDS.refreshCreditStates}:2099-12-31T23:55`
    const neonMeteringKey = `${JOB_KINDS.meterNeonDatabases}:2099-12-31T23`
    const valkeyMeteringKey = `${JOB_KINDS.meterValkeyQueues}:2099-12-31T23:55`
    const searchSecurityKey = `${JOB_KINDS.reconcileSearchSecurity}:2099-12-31T23`
    const valkeyAclKey = `${JOB_KINDS.reconcileValkeyAcl}:2099-12-31T23`
    const staticLogKey = `${JOB_KINDS.scanStaticCloudFrontLogs}:2099-12-31T23:55`
    const platformCertificateKey = `${JOB_KINDS.reconcilePlatformEdgeCertificate}:2099-12-31T23:58`
    const statementKey = `${JOB_KINDS.generateStatements}:2099-12-31`

    // Calling the scheduler repeatedly is how every worker uses it. The idempotency key, not a
    // process-local timer, is what makes one job per window.
    const previousRollout = process.env.PLATFORM_EDGE_ROLLOUT_ENABLED
    process.env.PLATFORM_EDGE_ROLLOUT_ENABLED = "0"
    try {
      await scheduleRecurring(db, now)
      await scheduleRecurring(db, now)
    } finally {
      if (previousRollout === undefined) delete process.env.PLATFORM_EDGE_ROLLOUT_ENABLED
      else process.env.PLATFORM_EDGE_ROLLOUT_ENABLED = previousRollout
    }

    const scheduled = await db
      .selectFrom("backgroundJob")
      .select(["kind", "idempotencyKey"])
      .where("idempotencyKey", "in", [
        relayKey,
        reconcileUsageKey,
        importKey,
        creditKey,
        neonMeteringKey,
        valkeyMeteringKey,
        searchSecurityKey,
        valkeyAclKey,
        staticLogKey,
        platformCertificateKey,
        statementKey,
      ])
      .orderBy("kind")
      .execute()

    expect(scheduled).toEqual([
      { kind: JOB_KINDS.generateStatements, idempotencyKey: statementKey },
      { kind: JOB_KINDS.importUsage, idempotencyKey: importKey },
      { kind: JOB_KINDS.meterNeonDatabases, idempotencyKey: neonMeteringKey },
      { kind: JOB_KINDS.meterValkeyQueues, idempotencyKey: valkeyMeteringKey },
      { kind: JOB_KINDS.reconcileActiveUsage, idempotencyKey: reconcileUsageKey },
      { kind: JOB_KINDS.refreshCreditStates, idempotencyKey: creditKey },
      { kind: JOB_KINDS.relayMeteringOutbox, idempotencyKey: relayKey },
      { kind: JOB_KINDS.scanStaticCloudFrontLogs, idempotencyKey: staticLogKey },
      {
        kind: JOB_KINDS.reconcilePlatformEdgeCertificate,
        idempotencyKey: platformCertificateKey,
      },
      { kind: JOB_KINDS.reconcileSearchSecurity, idempotencyKey: searchSecurityKey },
      { kind: JOB_KINDS.reconcileValkeyAcl, idempotencyKey: valkeyAclKey },
    ])
  })
})
