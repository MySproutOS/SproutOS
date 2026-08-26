import { createHash } from "node:crypto"

import { Kafka, Partitioners, type KafkaConfig, type Producer, type ProducerConfig } from "kafkajs"
import type { BillableDimension } from "./dimensions"

/** The dedicated durable buffer for raw, post-validation metering events. */
export const DEFAULT_USAGE_EVENT_TOPIC = "usage-events"

/**
 * One row on the raw usage-event topic.
 *
 * This is deliberately the post-validation shape, not the signed ingest shape. The ingest route
 * has already decided whether the organization exists and whether a project id is still valid;
 * publishing the caller's unnormalised ids would move that decision into every consumer.
 *
 * Dates are represented as `Date` in application code and encoded as ClickHouse-compatible
 * millisecond timestamps on the wire. Decimal quantities and the UInt64 version stay strings so
 * JavaScript cannot round either one before ClickHouse parses it.
 */
export type UsageEventRecord = {
  eventId: string
  organizationId: string
  projectId: string | null
  resourceType: string
  resourceId: string | null
  dimension: BillableDimension
  quantity: string
  occurredAt: Date
  windowStart: Date | null
  windowEnd: Date | null
  nodeId: string | null
  podUid: string | null
  source: string
  externalId: string
  chargedExternally: boolean
  attributes: Record<string, string>
  ingestedAt: Date
  /** Decimal UInt64. Today this is the ingest timestamp in epoch milliseconds. */
  version: string
}

export type NewUsageEventRecord = Omit<UsageEventRecord, "eventId" | "ingestedAt" | "version"> & {
  ingestedAt?: Date
  version?: string
}

/**
 * Stable identity for retries of the same source event.
 *
 * Length-prefixing makes the preimage unambiguous even when a source or external id contains the
 * separator. A generated UUID cannot do that job: retrying a batch would generate a new UUID and
 * ClickHouse would retain both copies.
 */
export function usageEventId(input: {
  source: string
  externalId: string
  occurredAt: Date | number
}): string {
  const occurredAt =
    input.occurredAt instanceof Date ? input.occurredAt.getTime() : input.occurredAt
  if (!Number.isSafeInteger(occurredAt)) {
    throw new Error("occurredAt must be a whole, safely representable Unix millisecond timestamp")
  }

  const digest = createHash("sha256")
  for (const part of [input.source, input.externalId, String(occurredAt)]) {
    digest.update(String(Buffer.byteLength(part, "utf8")))
    digest.update(":")
    digest.update(part)
  }
  return digest.digest("hex")
}

/** Build the row and its retry-stable identity at one boundary. */
export function usageEventRecord(input: NewUsageEventRecord): UsageEventRecord {
  const ingestedAt = input.ingestedAt ?? new Date()
  const version = input.version ?? String(ingestedAt.getTime())
  requireValidDate(ingestedAt, "ingestedAt")
  requireValidDate(input.occurredAt, "occurredAt")
  if (input.windowStart !== null) requireValidDate(input.windowStart, "windowStart")
  if (input.windowEnd !== null) requireValidDate(input.windowEnd, "windowEnd")
  if (!/^\d+$/.test(version)) throw new Error("version must be a decimal UInt64")

  return {
    ...input,
    eventId: usageEventId(input),
    ingestedAt,
    version,
  }
}

/**
 * A plain decimal spelling ClickHouse's `Decimal` input accepts.
 *
 * `Number#toString` switches to exponent notation for small and large quantities. Expanding that
 * spelling is lossless—the digits are still JavaScript's shortest round-trippable representation—
 * and avoids relying on a ClickHouse setting to decide whether `1e-7` is a decimal.
 */
export function decimalQuantity(value: number | string): string {
  if (typeof value === "string") {
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
      throw new Error(`quantity is not a plain decimal: ${JSON.stringify(value)}`)
    }
    return value
  }
  if (!Number.isFinite(value)) throw new Error("quantity must be finite")

  const rendered = String(value)
  if (!/[eE]/.test(rendered)) return rendered

  const [coefficient = "", exponentText = ""] = rendered.toLowerCase().split("e")
  const exponent = Number(exponentText)
  const negative = coefficient.startsWith("-")
  const unsigned = negative ? coefficient.slice(1) : coefficient
  const [whole = "", fraction = ""] = unsigned.split(".")
  const digits = `${whole}${fraction}`
  const point = whole.length + exponent
  const expanded =
    point <= 0
      ? `0.${"0".repeat(-point)}${digits}`
      : point >= digits.length
        ? `${digits}${"0".repeat(point - digits.length)}`
        : `${digits.slice(0, point)}.${digits.slice(point)}`
  return negative ? `-${expanded}` : expanded
}

/** The exact JSONEachRow object consumed by ClickHouse's Kafka table. */
export function encodeUsageEvent(record: UsageEventRecord): string {
  return JSON.stringify({
    event_id: record.eventId,
    organization_id: record.organizationId,
    project_id: record.projectId,
    resource_type: record.resourceType,
    resource_id: record.resourceId,
    dimension: record.dimension,
    quantity: decimalQuantity(record.quantity),
    occurred_at: clickhouseTimestamp(record.occurredAt),
    window_start: record.windowStart === null ? null : clickhouseTimestamp(record.windowStart),
    window_end: record.windowEnd === null ? null : clickhouseTimestamp(record.windowEnd),
    node_id: record.nodeId,
    pod_uid: record.podUid,
    source: record.source,
    external_id: record.externalId,
    charged_externally: record.chargedExternally,
    attributes: record.attributes,
    ingested_at: clickhouseTimestamp(record.ingestedAt),
    version: record.version,
  })
}

export type UsageEventKafkaConfig = {
  brokers: string[]
  topic: string
  clientId: string
  ssl: boolean
  sasl?: {
    mechanism: "scram-sha-512"
    username: string
    password: string
  }
}

/**
 * Plaintext on the local Docker network; TLS plus SCRAM-SHA-512 across the public internet.
 *
 * This mirrors the router producer's transport with a different, usage-topic-only principal. A
 * username is the switch because production's external Kafka listener requires both layers, while
 * local and CI listeners intentionally have neither. Half a credential is refused before KafkaJS
 * can turn it into a misleading handshake.
 */
export function usageEventKafkaConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): UsageEventKafkaConfig {
  // Host-run API development reaches Docker through the published listener; containers and
  // production use KAFKA_BROKERS directly.
  const brokers = (env.KAFKA_BROKERS_HOST ?? env.KAFKA_BROKERS ?? "")
    .split(",")
    .map((broker) => broker.trim())
    .filter(Boolean)
  if (brokers.length === 0) throw new Error("KAFKA_BROKERS_HOST or KAFKA_BROKERS is not set")
  if (brokers.some((broker) => !/^[A-Za-z0-9._-]+:\d+$/.test(broker))) {
    throw new Error(`KAFKA_BROKERS is not a host:port list: ${JSON.stringify(brokers)}`)
  }

  const configuredTopic = env.KAFKA_USAGE_EVENT_TOPIC
  const topic =
    configuredTopic === undefined || configuredTopic === ""
      ? DEFAULT_USAGE_EVENT_TOPIC
      : configuredTopic
  if (!/^[A-Za-z0-9._-]{1,249}$/.test(topic) || topic === "." || topic === "..") {
    throw new Error(`KAFKA_USAGE_EVENT_TOPIC is not a Kafka topic name: ${JSON.stringify(topic)}`)
  }

  const username = env.KAFKA_USAGE_EVENT_SASL_USERNAME ?? ""
  const password = env.KAFKA_USAGE_EVENT_SASL_PASSWORD ?? ""
  if ((username === "") !== (password === "")) {
    throw new Error(
      "KAFKA_USAGE_EVENT_SASL_USERNAME and KAFKA_USAGE_EVENT_SASL_PASSWORD must be set together",
    )
  }

  return {
    brokers,
    topic,
    clientId: "sproutos-usage-events",
    ssl: username !== "",
    ...(username === ""
      ? {}
      : { sasl: { mechanism: "scram-sha-512" as const, username, password } }),
  }
}

export type UsageEventProducer = {
  send: (events: UsageEventRecord[]) => Promise<void>
  sendEncoded: (events: { eventId: string; value: string }[]) => Promise<void>
  disconnect: () => Promise<void>
}

type ProducerClient = Pick<Producer, "connect" | "disconnect" | "send">
type KafkaClient = { producer: (config?: ProducerConfig) => ProducerClient }
export type KafkaFactory = (config: KafkaConfig) => KafkaClient

/**
 * Connect the producer whose successful return means every replica acknowledged the batch.
 *
 * `acks: -1` is explicit even though KafkaJS currently defaults to it. Durability is the contract
 * of this producer; it must not change when a library default does. One message per event gives
 * ClickHouse an independently deduplicable row, keyed by the same stable id it stores.
 */
export async function connectUsageEventProducer(
  config: UsageEventKafkaConfig = usageEventKafkaConfigFromEnv(),
  makeKafka: KafkaFactory = (kafkaConfig) => new Kafka(kafkaConfig),
): Promise<UsageEventProducer> {
  const kafka = makeKafka({
    clientId: config.clientId,
    brokers: config.brokers,
    ssl: config.ssl,
    ...(config.sasl === undefined ? {} : { sasl: config.sasl }),
  })
  const producer = kafka.producer({
    allowAutoTopicCreation: false,
    // Explicitly select KafkaJS v2's partitioner. Keys are stable event ids, and being explicit
    // avoids both a process-wide warning and a future default silently moving existing keys.
    createPartitioner: Partitioners.DefaultPartitioner,
  })
  await producer.connect()

  const sendEncoded = async (events: { eventId: string; value: string }[]) => {
    if (events.length === 0) return
    await producer.send({
      topic: config.topic,
      acks: -1,
      messages: events.map((event) => ({ key: event.eventId, value: event.value })),
    })
  }

  return {
    send: async (events) =>{ 
      await sendEncoded(
        events.map((event) => ({ eventId: event.eventId, value: encodeUsageEvent(event) })),
      ); },
    sendEncoded,
    disconnect: () => producer.disconnect(),
  }
}

function clickhouseTimestamp(value: Date): string {
  requireValidDate(value, "timestamp")
  return value.toISOString().replace("T", " ").replace("Z", "")
}

function requireValidDate(value: Date, name: string): void {
  if (Number.isNaN(value.getTime())) throw new Error(`${name} is not a valid date`)
}
