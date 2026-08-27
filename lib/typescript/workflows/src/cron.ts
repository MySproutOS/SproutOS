import { CronExpressionParser } from "cron-parser"

/** The next occurrence strictly after `after`, with IANA timezone and DST handled by cron-parser. */
export function nextCronAt(expression: string, timezone: string, after: Date): Date {
  return CronExpressionParser.parse(expression, { currentDate: after, tz: timezone })
    .next()
    .toDate()
}

/** The single cron trigger a validated graph carries, if it is cron-driven. */
export function cronTriggerConfig(graph: {
  nodes: { type: string; config: Record<string, unknown> }[]
}): { expression: string; timezone: string } | undefined {
  const trigger = graph.nodes.find((node) => node.type === "trigger.cron")
  if (trigger === undefined) return undefined
  const expression = trigger.config.cronExpression ?? trigger.config.cron
  const timezone = trigger.config.timezone ?? "UTC"
  if (typeof expression !== "string" || expression.trim() === "") {
    throw new Error("A cron trigger needs a cronExpression")
  }
  if (typeof timezone !== "string" || timezone.trim() === "") {
    throw new Error("A cron trigger needs an IANA timezone")
  }
  // Parse now so an invalid expression or timezone is rejected while saving, not in the scheduler.
  nextCronAt(expression, timezone, new Date())
  return { expression, timezone }
}
