import { StartInstanceRefreshCommand, type AutoScalingClient } from "@aws-sdk/client-auto-scaling"
import {
  ChangeResourceRecordSetsCommand,
  GetChangeCommand,
  ListResourceRecordSetsCommand,
  type Route53Client,
} from "@aws-sdk/client-route-53"
import type { S3Client } from "@aws-sdk/client-s3"
import type { SecretsManagerClient } from "@aws-sdk/client-secrets-manager"
import { db } from "@sproutos/db"
import type { Redis } from "ioredis"
import { sql } from "kysely"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  nextPlatformRenewal,
  platformCertificateConfig,
  platformCertificateNames,
  platformCertificateObject,
  platformVersionKey,
  putDnsChallenge,
  removeDnsChallenge,
  requestPlatformRestart,
  retryAfter,
  reconcilePlatformEdgeCertificate,
} from "./platform-edge-certificate"

const databaseReachable = await (async () => {
  try {
    await sql`select 1`.execute(db)
    return true
  } catch {
    return false
  }
})()

afterAll(async () => {
  if (!databaseReachable) return
  await db.deleteFrom("platformEdgeCertificate").where("id", "=", "platform").execute()
  await db.destroy()
})

function route53(responses: unknown[]) {
  const send = vi.fn<(command: unknown) => Promise<unknown>>(() =>
    Promise.resolve(responses.shift()),
  )
  return { client: { send } as unknown as Route53Client, send }
}

describe("platform edge DNS-01", () => {
  it("adds the digest without destroying an existing TXT value and waits for INSYNC", async () => {
    const { client, send } = route53([
      {
        ResourceRecordSets: [
          {
            Name: "_acme-challenge.sproutos.run.",
            Type: "TXT",
            TTL: 60,
            ResourceRecords: [{ Value: '"another-order"' }],
          },
        ],
      },
      { ChangeInfo: { Id: "change-1" } },
      { ChangeInfo: { Status: "PENDING" } },
      { ChangeInfo: { Status: "INSYNC" } },
    ])
    const sleep = vi.fn<(milliseconds: number) => Promise<void>>(() => Promise.resolve())

    await putDnsChallenge(client, "tenant-zone", "sproutos.run", "token.key-authorization", sleep)

    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(ListResourceRecordSetsCommand)
    const change = send.mock.calls[1]?.[0]
    expect(change).toBeInstanceOf(ChangeResourceRecordSetsCommand)
    if (!(change instanceof ChangeResourceRecordSetsCommand)) throw new Error("missing change")
    expect(change.input).toMatchObject({
      HostedZoneId: "tenant-zone",
      ChangeBatch: {
        Changes: [
          {
            Action: "UPSERT",
            ResourceRecordSet: {
              Name: "_acme-challenge.sproutos.run",
              Type: "TXT",
              ResourceRecords: [
                { Value: '"another-order"' },
                { Value: '"wv7eJTUZ5tMiXm-P0dhwZc_pwCFublVy_ZXIxPJtOXs"' },
              ],
            },
          },
        ],
      },
    })
    expect(send.mock.calls[2]?.[0]).toBeInstanceOf(GetChangeCommand)
    expect(send.mock.calls[3]?.[0]).toBeInstanceOf(GetChangeCommand)
    expect(sleep).toHaveBeenCalledOnce()
  })

  it("removes only its own digest and preserves a concurrent TXT value", async () => {
    const digest = '"wv7eJTUZ5tMiXm-P0dhwZc_pwCFublVy_ZXIxPJtOXs"'
    const { client, send } = route53([
      {
        ResourceRecordSets: [
          {
            Name: "_acme-challenge.sproutos.run.",
            Type: "TXT",
            TTL: 60,
            ResourceRecords: [{ Value: digest }, { Value: '"another-order"' }],
          },
        ],
      },
      { ChangeInfo: { Id: "change-2" } },
      { ChangeInfo: { Status: "INSYNC" } },
    ])

    await removeDnsChallenge(
      client,
      "tenant-zone",
      "*.sproutos.run",
      "token.key-authorization",
      () => Promise.resolve(),
    )

    const change = send.mock.calls[1]?.[0]
    if (!(change instanceof ChangeResourceRecordSetsCommand)) throw new Error("missing change")
    expect(change.input.ChangeBatch?.Changes).toEqual([
      {
        Action: "UPSERT",
        ResourceRecordSet: {
          Name: "_acme-challenge.sproutos.run.",
          Type: "TXT",
          TTL: 60,
          ResourceRecords: [{ Value: '"another-order"' }],
        },
      },
    ])
  })
})

describe("platform certificate lifecycle", () => {
  beforeEach(() => {
    vi.stubEnv("TENANT_DOMAIN", "sproutos.run")
    vi.stubEnv("PLATFORM_EDGE_EGRESS_HOSTNAME", "egress.sproutos.me")
    vi.stubEnv("PLATFORM_ACME_TENANT_ZONE_ID", "tenant-zone")
    vi.stubEnv("PLATFORM_ACME_EGRESS_ZONE_ID", "main-zone")
    vi.stubEnv("PLATFORM_ROUTER_ASG_NAMES", "router-blue,router-green")
    vi.stubEnv("PLATFORM_EDGE_ROLLOUT_ENABLED", "1")
    vi.stubEnv("TENANT_CERTIFICATE_BUCKET", "certificate-bucket")
    vi.stubEnv("TENANT_CERTIFICATE_KMS_KEY_ARN", "kms-key")
  })
  afterEach(() => vi.unstubAllEnvs())

  it("builds a startup object for the tenant apex, wildcard, and exact egress hostname", () => {
    const config = platformCertificateConfig()
    expect(config).toMatchObject({
      wildcardHostname: "*.sproutos.run",
      egressHostname: "egress.sproutos.me",
      routerAsgNames: ["router-blue", "router-green"],
      rolloutEnabled: true,
    })
    expect(platformCertificateNames(config)).toEqual([
      "sproutos.run",
      "*.sproutos.run",
      "egress.sproutos.me",
    ])
    expect(
      JSON.parse(
        platformCertificateObject(config, {
          certificatePem: "certificate",
          privateKeyPem: "private-key",
          issuedAt: new Date("2026-08-01T00:00:00Z"),
          expiresAt: new Date("2026-11-01T00:00:00Z"),
        }),
      ),
    ).toEqual({
      version: 1,
      hostname: "*.sproutos.run",
      hostnames: ["sproutos.run", "*.sproutos.run", "egress.sproutos.me"],
      certificatePem: "certificate",
      privateKeyPem: "private-key",
      issuedAt: "2026-08-01T00:00:00.000Z",
      expiresAt: "2026-11-01T00:00:00.000Z",
    })
  })

  it("renews from actual expiry and bounds retry backoff", () => {
    expect(nextPlatformRenewal(new Date("2026-11-01T00:00:00Z"))).toEqual(
      new Date("2026-10-02T00:00:00Z"),
    )
    const now = new Date("2026-08-28T00:00:00Z")
    expect(retryAfter(now, 1)).toEqual(new Date("2026-08-28T00:02:00Z"))
    expect(retryAfter(now, 100)).toEqual(new Date("2026-08-28T17:04:00Z"))
    expect(platformVersionKey("version/with*glob")).toBe(
      "a0d192c5d79e98b913fb9b3f806239b90a99adf9b1ff24d4bc14bd42c519d18a",
    )
  })

  it("submits a safe rolling refresh for every router ASG", async () => {
    const send = vi.fn<(command: unknown) => Promise<unknown>>(() =>
      Promise.resolve({ InstanceRefreshId: "refresh" }),
    )
    await requestPlatformRestart(
      { send } as unknown as AutoScalingClient,
      platformCertificateConfig(),
    )

    expect(send).toHaveBeenCalledTimes(2)
    for (const [command] of send.mock.calls) {
      expect(command).toBeInstanceOf(StartInstanceRefreshCommand)
      if (!(command instanceof StartInstanceRefreshCommand)) throw new Error("missing refresh")
      expect(command.input.Preferences).toMatchObject({
        InstanceWarmup: 180,
        MinHealthyPercentage: 100,
        MaxHealthyPercentage: 200,
        SkipMatching: false,
      })
      expect(command.input.Preferences?.AutoRollback).toBeUndefined()
    }
  })

  it("treats an already-running refresh as the accepted idempotent handoff", async () => {
    const inProgress = new Error("already running")
    inProgress.name = "InstanceRefreshInProgressFault"
    const send = vi
      .fn<(command: unknown) => Promise<unknown>>()
      .mockRejectedValueOnce(inProgress)
      .mockResolvedValueOnce({ InstanceRefreshId: "refresh" })

    await expect(
      requestPlatformRestart({ send } as unknown as AutoScalingClient, platformCertificateConfig()),
    ).resolves.toBeUndefined()
    expect(send).toHaveBeenCalledTimes(2)
  })
})

describe.runIf(databaseReachable)("platform certificate durable handoff", () => {
  beforeEach(async () => {
    vi.stubEnv("TENANT_DOMAIN", "sproutos.run")
    vi.stubEnv("PLATFORM_EDGE_EGRESS_HOSTNAME", "egress.sproutos.me")
    vi.stubEnv("PLATFORM_ACME_TENANT_ZONE_ID", "tenant-zone")
    vi.stubEnv("PLATFORM_ACME_EGRESS_ZONE_ID", "main-zone")
    vi.stubEnv("PLATFORM_ROUTER_ASG_NAMES", "router")
    vi.stubEnv("PLATFORM_EDGE_ROLLOUT_ENABLED", "0")
    vi.stubEnv("TENANT_CERTIFICATE_BUCKET", "certificate-bucket")
    vi.stubEnv("TENANT_CERTIFICATE_KMS_KEY_ARN", "kms-key")
    vi.stubEnv("ROUTER_CERTIFICATE_MIN_ACKS", "1")
    await db.deleteFrom("platformEdgeCertificate").where("id", "=", "platform").execute()
  })
  afterEach(() => vi.unstubAllEnvs())

  it("stays pending until the restarted router acknowledges the exact S3 version", async () => {
    let loaded = false
    const autoScalingSend = vi.fn<(command: unknown) => Promise<unknown>>(() =>
      Promise.resolve({ InstanceRefreshId: "refresh-1" }),
    )
    const handler = reconcilePlatformEdgeCertificate({
      now: () => new Date("2099-01-01T00:00:00Z"),
      autoScaling: { send: autoScalingSend } as unknown as AutoScalingClient,
      route53: {
        send: vi.fn<(command: unknown) => Promise<unknown>>(),
      } as unknown as Route53Client,
      s3: {
        send: vi.fn<(command: unknown) => Promise<unknown>>(() =>
          Promise.resolve({ VersionId: "s3-version-1" }),
        ),
      } as unknown as S3Client,
      secrets: {
        send: vi.fn<(command: unknown) => Promise<unknown>>(),
      } as unknown as SecretsManagerClient,
      valkey: {
        scan: vi.fn<(...arguments_: unknown[]) => Promise<[string, string[]]>>(() =>
          Promise.resolve(["0", loaded ? ["ack"] : []]),
        ),
      } as unknown as Redis,
      sleep: () => Promise.resolve(),
      issue: () =>
        Promise.resolve({
          certificatePem: "certificate",
          privateKeyPem: "private-key",
          issuedAt: new Date("2099-01-01T00:00:00Z"),
          expiresAt: new Date("2099-04-01T00:00:00Z"),
        }),
    })
    const context = {
      db,
      keepAlive: () => Promise.resolve(true),
      signal: new AbortController().signal,
    }

    await handler({} as never, context)
    const waiting = await db
      .selectFrom("platformEdgeCertificate")
      .selectAll()
      .where("id", "=", "platform")
      .executeTakeFirstOrThrow()
    expect(waiting).toMatchObject({
      status: "awaiting_deployment",
      certificateObjectVersion: "s3-version-1",
      restartRequestedObjectVersion: null,
      deployedObjectVersion: null,
    })
    expect(waiting.statusReason).toContain("PLATFORM_EDGE_ROLLOUT_ENABLED=1")
    expect(autoScalingSend).not.toHaveBeenCalled()

    vi.stubEnv("PLATFORM_EDGE_ROLLOUT_ENABLED", "1")
    await handler({} as never, context)
    const restarting = await db
      .selectFrom("platformEdgeCertificate")
      .select(["status", "restartRequestedObjectVersion"])
      .where("id", "=", "platform")
      .executeTakeFirstOrThrow()
    expect(restarting).toEqual({
      status: "awaiting_deployment",
      restartRequestedObjectVersion: "s3-version-1",
    })
    expect(autoScalingSend).toHaveBeenCalledOnce()

    loaded = true
    await handler({} as never, context)
    const active = await db
      .selectFrom("platformEdgeCertificate")
      .select(["status", "deployedObjectVersion"])
      .where("id", "=", "platform")
      .executeTakeFirstOrThrow()
    expect(active).toEqual({ status: "active", deployedObjectVersion: "s3-version-1" })
    expect(autoScalingSend).toHaveBeenCalledOnce()
  })
})
