import type { RuntimeLog } from "./runtime-logs"

/**
 * Turning a Lambda `REPORT` line into what the customer is charged.
 *
 * ## Billed the way AWS bills us
 *
 * **GB-seconds of billed duration, plus one charge per request.** Not active CPU, and not vCPU:
 * Lambda allocates CPU in proportion to configured memory, so there is no vCPU to meter, and it
 * charges wall-clock *billed* duration whether the invocation was computing or waiting on a
 * database. Metering the active portion — the Fluid Compute model — would have the platform charge
 * less than the invocation cost it, on exactly the IO-bound requests that make up most of a
 * database-backed application.
 *
 * ## `Billed Duration`, not `Duration`
 *
 * They differ. `Duration` is what the handler took; `Billed Duration` is what AWS rounds it to, and
 * on a cold start it *includes the init* that `Duration` excludes. Metering `Duration` would
 * silently absorb every cold start's initialisation as platform cost.
 */

export type UsageEvent = {
  dimension: "site_gib_second" | "site_request"
  /**
   * The metered amount, as a decimal string.
   *
   * GB-seconds of a 128 MB function running 2 ms is 0.00025 — a number that floors to zero as an
   * integer and loses a fifth of its value as a float32. The ledger's own amounts are `bigint`
   * micro-USD; this is a *quantity*, and quantities are rated before they become money.
   */
  quantity: string
  projectId: string
  deploymentId: string
  requestId: string
  occurredAt: Date
}

/** Lambda's own unit: memory in GB, where a GB is 1024 MB, times billed seconds. */
export function gbSeconds(memoryMb: number, billedMs: number): number {
  return (memoryMb / 1024) * (billedMs / 1000)
}

/**
 * The usage a single invocation produced, or nothing if this line is not a report.
 *
 * One `site_request` per report rather than per log line: a report is emitted once per invocation,
 * which is exactly what AWS counts. Counting `START` lines would give the same answer today and a
 * different one the day a runtime stops emitting them.
 */
export function usageFrom(log: RuntimeLog): UsageEvent[] {
  if (log.billedMs === undefined || log.memoryMb === undefined) return []

  const common = {
    projectId: log.projectId,
    deploymentId: log.deploymentId,
    requestId: log.requestId,
    occurredAt: log.ts,
  }

  return [
    {
      dimension: "site_gib_second",
      // Nine decimal places: the price book's own `numeric(38, 9)`. Truncating further would round
      // a short invocation to zero, and a platform that bills nothing for short requests is one
      // whose cheapest customers are its most expensive.
      quantity: gbSeconds(log.memoryMb, log.billedMs).toFixed(9),
      ...common,
    },
    { dimension: "site_request", quantity: "1", ...common },
  ]
}

/** Every invocation in a batch of log lines. */
export function usageFromBatch(logs: RuntimeLog[]): UsageEvent[] {
  return logs.flatMap(usageFrom)
}
