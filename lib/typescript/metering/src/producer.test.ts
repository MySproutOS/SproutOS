import { describe, expect, it, vi } from "vitest"
import { Partitioners, type Producer, type ProducerConfig } from "kafkajs"

import {
  connectUsageEventProducer,
  decimalQuantity,
  encodeUsageEvent,
  usageEventId,
  usageEventKafkaConfigFromEnv,
  usageEventRecord,
  type KafkaFactory,
} from "./producer"

const occurredAt = new Date("2026-08-26T12:34:56.789Z")

function record() {
  return usageEventRecord({
    organizationId: "01990000-0000-7000-8000-000000000001",
    projectId: "01990000-0000-7000-8000-000000000002",
    resourceType: "site",
    resourceId: null,
    dimension: "site_gib_second",
    quantity: decimalQuantity(1e-7),
    occurredAt,
    windowStart: new Date("2026-08-26T12:34:00.000Z"),
    windowEnd: null,
    nodeId: "node-1",
    podUid: null,
    source: "metering-agent",
    externalId: "node-1:pod-1:1756211696789",
    chargedExternally: false,
    attributes: { region: "iad", workload: "api" },
    ingestedAt: new Date("2026-08-26T12:35:00.123Z"),
  })
}

describe("usage event identity and wire format", () => {
  it("derives a stable lowercase SHA-256 identity from the source event", () => {
    const first = usageEventId({ source: "a", externalId: "bc", occurredAt })
    const retried = usageEventId({
      source: "a",
      externalId: "bc",
      occurredAt: occurredAt.getTime(),
    })
    const ambiguousWithoutLengths = usageEventId({ source: "ab", externalId: "c", occurredAt })

    expect(first).toBe(retried)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(ambiguousWithoutLengths).not.toBe(first)
  })

  it("encodes the exact snake-case JSONEachRow shape", () => {
    const encoded = JSON.parse(encodeUsageEvent(record())) as Record<string, unknown>

    expect(Object.keys(encoded).toSorted()).toEqual([
      "attributes",
      "charged_externally",
      "dimension",
      "event_id",
      "external_id",
      "ingested_at",
      "node_id",
      "occurred_at",
      "organization_id",
      "pod_uid",
      "project_id",
      "quantity",
      "resource_id",
      "resource_type",
      "source",
      "version",
      "window_end",
      "window_start",
    ])
    expect(encoded.quantity).toBe("0.0000001")
    expect(encoded.occurred_at).toBe("2026-08-26 12:34:56.789")
    expect(encoded.ingested_at).toBe("2026-08-26 12:35:00.123")
    expect(encoded.window_end).toBeNull()
    expect(encoded.version).toBe(String(new Date("2026-08-26T12:35:00.123Z").getTime()))
  })

  it.each([
    [1e-7, "0.0000001"],
    [1e21, "1000000000000000000000"],
    [-2.5e3, "-2500"],
    [0.125, "0.125"],
  ])("writes %s without exponent notation", (quantity, expected) => {
    expect(decimalQuantity(quantity)).toBe(expected)
  })
})

describe("usage event Kafka configuration", () => {
  it("uses plaintext only for local Kafka", () => {
    expect(
      usageEventKafkaConfigFromEnv({
        KAFKA_BROKERS: "kafka:9092",
        KAFKA_BROKERS_HOST: " localhost:29092 ",
      }),
    ).toEqual({
      brokers: ["localhost:29092"],
      topic: "usage-events",
      clientId: "sproutos-usage-events",
      ssl: false,
    })
  })

  it("uses TLS and SCRAM-SHA-512 together in production", () => {
    expect(
      usageEventKafkaConfigFromEnv({
        KAFKA_BROKERS: "kafka.sproutos.me:9094",
        KAFKA_USAGE_EVENT_TOPIC: "prod-usage-events",
        KAFKA_USAGE_EVENT_SASL_USERNAME: "producer",
        KAFKA_USAGE_EVENT_SASL_PASSWORD: "secret",
      }),
    ).toMatchObject({
      ssl: true,
      topic: "prod-usage-events",
      sasl: { mechanism: "scram-sha-512", username: "producer", password: "secret" },
    })
  })

  it("does not inherit the runtime-log principal", () => {
    expect(
      usageEventKafkaConfigFromEnv({
        KAFKA_BROKERS: "kafka:9092",
        KAFKA_SASL_USERNAME: "runtime-log-producer",
        KAFKA_SASL_PASSWORD: "runtime-log-secret",
      }),
    ).toEqual({
      brokers: ["kafka:9092"],
      topic: "usage-events",
      clientId: "sproutos-usage-events",
      ssl: false,
    })
  })

  it("refuses partial credentials and invalid broker or topic names", () => {
    expect(() =>
      usageEventKafkaConfigFromEnv({
        KAFKA_BROKERS: "kafka:9092",
        KAFKA_USAGE_EVENT_SASL_USERNAME: "producer",
      }),
    ).toThrow(/must be set together/)
    expect(() =>
      usageEventKafkaConfigFromEnv({
        KAFKA_BROKERS: "kafka:9092",
        KAFKA_USAGE_EVENT_TOPIC: "bad topic",
      }),
    ).toThrow(/not a Kafka topic name/)
    expect(() =>
      usageEventKafkaConfigFromEnv({ KAFKA_BROKERS: "SASL_SSL://kafka.example:9094" }),
    ).toThrow(/not a host:port list/)
  })
})

describe("publishing usage events", () => {
  it("waits for an ack-all send keyed by event id", async () => {
    const connect = vi.fn<Producer["connect"]>(() => Promise.resolve())
    const disconnect = vi.fn<Producer["disconnect"]>(() => Promise.resolve())
    const send = vi.fn<Producer["send"]>(() => Promise.resolve([]))
    const producer = vi.fn<
      (config?: ProducerConfig) => Pick<Producer, "connect" | "disconnect" | "send">
    >(() => ({ connect, disconnect, send }))
    const factory = (() => ({ producer })) as KafkaFactory

    const connected = await connectUsageEventProducer(
      {
        brokers: ["kafka:9092"],
        topic: "usage-events",
        clientId: "test-usage-events",
        ssl: false,
      },
      factory,
    )
    const event = record()
    await connected.send([event])

    expect(connect).toHaveBeenCalledOnce()
    expect(producer).toHaveBeenCalledWith({
      allowAutoTopicCreation: false,
      createPartitioner: Partitioners.DefaultPartitioner,
    })
    expect(send).toHaveBeenCalledWith({
      topic: "usage-events",
      acks: -1,
      messages: [{ key: event.eventId, value: encodeUsageEvent(event) }],
    })

    send.mockClear()
    await connected.sendEncoded([{ eventId: event.eventId, value: '{"already":"encoded"}' }])
    expect(send).toHaveBeenCalledWith({
      topic: "usage-events",
      acks: -1,
      messages: [{ key: event.eventId, value: '{"already":"encoded"}' }],
    })

    await connected.disconnect()
    expect(disconnect).toHaveBeenCalledOnce()
  })

  it("does not ask Kafka to publish an empty batch", async () => {
    const send = vi.fn<Producer["send"]>(() => Promise.resolve([]))
    const factory = (() => ({
      producer: () => ({
        connect: () => Promise.resolve(),
        disconnect: () => Promise.resolve(),
        send,
      }),
    })) as unknown as KafkaFactory
    const connected = await connectUsageEventProducer(
      {
        brokers: ["kafka:9092"],
        topic: "usage-events",
        clientId: "test-usage-events",
        ssl: false,
      },
      factory,
    )

    await connected.send([])
    expect(send).not.toHaveBeenCalled()
  })
})
