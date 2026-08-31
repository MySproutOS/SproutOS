import { enqueue, JOB_KINDS } from "@lib/jobs"
import { db } from "@sproutos/db"
import { randomUUID } from "node:crypto"

/** Bounded production operator entrypoint: enqueue the normal scanner, never run GitHub writes inline. */
const invocation = process.argv[2] ?? randomUUID()
if (!/^[a-zA-Z0-9._:-]{1,120}$/.test(invocation)) {
  throw new Error("upkeep scan invocation must be 1-120 safe identifier characters")
}

try {
  const jobId = await enqueue(db, {
    kind: JOB_KINDS.upkeepScan,
    idempotencyKey: `${JOB_KINDS.upkeepScan}:operator:${invocation}`,
    maxAttempts: 5,
  })
  console.log(JSON.stringify({ jobId, invocation }))
} finally {
  await db.destroy()
}
