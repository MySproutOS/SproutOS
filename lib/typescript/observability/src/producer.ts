import { Kafka, type Producer } from "kafkajs"
import type { RuntimeLog } from "./runtime-logs"

/**
 * Putting runtime logs on the topic ClickHouse consumes.
 *
 * The producing end of the buffer. Whatever collects a customer's log lines — today the Lambda
 * extension — hands them here, and ClickHouse takes them off the topic on its own schedule. That
 * indirection is the point: the collector is not blocked by a slow ClickHouse, a brief outage costs
 * nothing, and a parsing bug can be replayed from an offset instead of being unrecoverable.
 */

/** The wire form. Snake case, because ClickHouse's `JSONEachRow` matches column names exactly. */
export function encode(log: RuntimeLog): string {
  return JSON.stringify({
    // ClickHouse's `DateTime64(3)` parses this form; an ISO string with a `Z` it does not.
    ts: log.ts.toISOString().replace("T", " ").replace("Z", ""),
    project_id: log.projectId,
    deployment_id: log.deploymentId,
    request_id: log.requestId,
    level: log.level,
    message: log.message,
    duration_ms: log.durationMs ?? null,
    billed_ms: log.billedMs ?? null,
    memory_mb: log.memoryMb ?? null,
    init_ms: log.initMs ?? null,
    cold_start: log.coldStart ?? null,
  })
}

export type LogProducer = {
  send: (logs: RuntimeLog[]) => Promise<void>
  disconnect: () => Promise<void>
}

export function topic(): string {
  return process.env.KAFKA_RUNTIME_LOG_TOPIC ?? "runtime-logs"
}

/**
 * Connect a producer.
 *
 * Keyed by project, so every line from one project lands on one partition and ClickHouse sees them
 * in the order they were produced. Without a key Kafka round-robins and a `REPORT` can be consumed
 * before the `START` of the same invocation — which is only cosmetic in a log viewer, and is not
 * cosmetic at all when the `REPORT` is what the customer is billed from.
 */
export async function connectProducer(brokers?: string[]): Promise<LogProducer> {
  const list = brokers ?? (process.env.KAFKA_BROKERS ?? "").split(",").filter(Boolean)
  if (list.length === 0) throw new Error("KAFKA_BROKERS is not set")

  const kafka = new Kafka({ clientId: "sproutos-logs", brokers: list })
  const producer: Producer = kafka.producer({ allowAutoTopicCreation: false })
  await producer.connect()

  return {
    send: async (logs) => {
      if (logs.length === 0) return
      await producer.send({
        topic: topic(),
        messages: logs.map((log) => ({ key: log.projectId, value: encode(log) })),
      })
    },
    disconnect: () => producer.disconnect(),
  }
}
