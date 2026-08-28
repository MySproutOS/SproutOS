import { StartInstanceRefreshCommand, type AutoScalingClient } from "@aws-sdk/client-auto-scaling"
import {
  ChangeResourceRecordSetsCommand,
  GetChangeCommand,
  ListResourceRecordSetsCommand,
  type Route53Client,
} from "@aws-sdk/client-route-53"
import { DeleteObjectCommand, type S3Client } from "@aws-sdk/client-s3"
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
  it("writes acme-client's digest unchanged and waits for authoritative and public DNS", async () => {
    const digest = "wv7eJTUZ5tMiXm-P0dhwZc_pwCFublVy_ZXIxPJtOXs"
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
    const resolvePublicTxt = vi
      .fn<(hostname: string) => Promise<string[][]>>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([[digest]])
    const resolveAuthoritativeTxt = vi.fn<
      (hostname: string, nameserver: string) => Promise<string[][]>
    >(() => Promise.resolve([[digest]]))

    await putDnsChallenge(client, "tenant-zone", "sproutos.run", digest, {
      sleep,
      dns: {
        resolveNameservers: () => Promise.resolve(["ns-1.example.test"]),
        resolvePublicTxt,
        resolveAuthoritativeTxt,
      },
    })

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
              ResourceRecords: [{ Value: '"another-order"' }, { Value: `"${digest}"` }],
            },
          },
        ],
      },
    })
    expect(send.mock.calls[2]?.[0]).toBeInstanceOf(GetChangeCommand)
    expect(send.mock.calls[3]?.[0]).toBeInstanceOf(GetChangeCommand)
    expect(resolvePublicTxt).toHaveBeenCalledTimes(2)
    expect(resolveAuthoritativeTxt).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it("replaces stale values on the first write for an order", async () => {
    const digest = "wv7eJTUZ5tMiXm-P0dhwZc_pwCFublVy_ZXIxPJtOXs"
    const { client, send } = route53([
      { ChangeInfo: { Id: "change-stale" } },
      { ChangeInfo: { Status: "INSYNC" } },
    ])

    await putDnsChallenge(client, "tenant-zone", "sproutos.run", digest, {
      replaceExisting: true,
      sleep: () => Promise.resolve(),
      dns: {
        resolveNameservers: () => Promise.resolve(["ns-1.example.test"]),
        resolvePublicTxt: () => Promise.resolve([[digest]]),
        resolveAuthoritativeTxt: () => Promise.resolve([[digest]]),
      },
    })

    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(ChangeResourceRecordSetsCommand)
    const change = send.mock.calls[0]?.[0]
    if (!(change instanceof ChangeResourceRecordSetsCommand)) throw new Error("missing change")
    expect(change.input.ChangeBatch?.Changes?.[0]?.ResourceRecordSet?.ResourceRecords).toEqual([
      { Value: `"${digest}"` },
    ])
    expect(
      send.mock.calls.some(([command]) => command instanceof ListResourceRecordSetsCommand),
    ).toBe(false)
  })

  it("does not continue while an authoritative nameserver still serves stale data", async () => {
    const digest = "wv7eJTUZ5tMiXm-P0dhwZc_pwCFublVy_ZXIxPJtOXs"
    const { client } = route53([
      { ResourceRecordSets: [] },
      { ChangeInfo: { Id: "change-authority" } },
      { ChangeInfo: { Status: "INSYNC" } },
    ])
    const sleep = vi.fn<(milliseconds: number) => Promise<void>>(() => Promise.resolve())

    await expect(
      putDnsChallenge(client, "tenant-zone", "sproutos.run", digest, {
        sleep,
        dns: {
          resolveNameservers: () => Promise.resolve(["current.example.test", "stale.example.test"]),
          resolvePublicTxt: () => Promise.resolve([[digest]]),
          resolveAuthoritativeTxt: (_hostname, nameserver) =>
            Promise.resolve(nameserver.startsWith("current") ? [[digest]] : [["old-value"]]),
        },
      }),
    ).rejects.toThrow("stale.example.test")
    expect(sleep).toHaveBeenCalledTimes(60)
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
      "wv7eJTUZ5tMiXm-P0dhwZc_pwCFublVy_ZXIxPJtOXs",
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
    vi.stubEnv("ACME_DIRECTORY_URL", "https://acme-staging.example/directory")
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
    vi.stubEnv("ACME_DIRECTORY_URL", "https://acme-staging.example/directory")
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
        eval: vi.fn<(...arguments_: unknown[]) => Promise<[number, number]>>(() =>
          Promise.resolve([1, loaded ? 1 : 0]),
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
      scheduleIssued: () =>
        Promise.resolve({
          certificateId: "aki.serial",
          issuer: "CN=Staging Test CA",
          nextRenewalAt: new Date("2099-03-02T00:00:00Z"),
          renewalInfoRetryAt: null,
          renewalInfoExplanationUrl: null,
          source: "unsupported",
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

  it("forces staging material through a production order before it can be activated", async () => {
    vi.stubEnv("ACME_DIRECTORY_URL", "https://acme-v02.example/directory")
    await db
      .insertInto("platformEdgeCertificate")
      .values({
        id: "platform",
        status: "active",
        certificateObjectKey: "platform-edge/current.json",
        certificateObjectVersion: "staging-version",
        deployedObjectVersion: "staging-version",
        certificateIssuer: "CN=Fake LE Intermediate X1",
        certificateDirectoryUrl: "https://acme-staging-v02.example/directory",
        renewalInfoCertificateId: "staging.123",
        certificateIssuedAt: new Date("2098-12-01T00:00:00Z"),
        certificateExpiresAt: new Date("2099-03-01T00:00:00Z"),
        nextRenewalAt: new Date("2099-02-01T00:00:00Z"),
        nextRetryAt: new Date("2099-02-01T00:00:00Z"),
      })
      .execute()
    const issue = vi.fn<
      () => Promise<{
        certificatePem: string
        privateKeyPem: string
        issuedAt: Date
        expiresAt: Date
      }>
    >(() =>
      Promise.resolve({
        certificatePem: "production-certificate",
        privateKeyPem: "production-private-key",
        issuedAt: new Date("2099-01-01T00:00:00Z"),
        expiresAt: new Date("2099-04-01T00:00:00Z"),
      }),
    )
    const handler = reconcilePlatformEdgeCertificate({
      now: () => new Date("2099-01-01T00:00:00Z"),
      autoScaling: {
        send: vi.fn<(command: unknown) => Promise<unknown>>(),
      } as unknown as AutoScalingClient,
      route53: {
        send: vi.fn<(command: unknown) => Promise<unknown>>(),
      } as unknown as Route53Client,
      s3: {
        send: vi.fn<(command: unknown) => Promise<unknown>>(() =>
          Promise.resolve({ VersionId: "production-version" }),
        ),
      } as unknown as S3Client,
      secrets: {
        send: vi.fn<(command: unknown) => Promise<unknown>>(),
      } as unknown as SecretsManagerClient,
      valkey: {
        eval: vi.fn<(...arguments_: unknown[]) => Promise<[number, number]>>(),
      } as unknown as Redis,
      sleep: () => Promise.resolve(),
      issue,
      scheduleIssued: () =>
        Promise.resolve({
          certificateId: "production.456",
          issuer: "CN=LE Intermediate R13",
          nextRenewalAt: new Date("2099-03-02T00:00:00Z"),
          renewalInfoRetryAt: new Date("2099-01-01T06:00:00Z"),
          renewalInfoExplanationUrl: null,
          source: "ari",
        }),
    })

    await handler({} as never, {
      db,
      keepAlive: () => Promise.resolve(true),
      signal: new AbortController().signal,
    })

    const state = await db
      .selectFrom("platformEdgeCertificate")
      .select([
        "status",
        "certificateDirectoryUrl",
        "certificateObjectVersion",
        "deployedObjectVersion",
      ])
      .where("id", "=", "platform")
      .executeTakeFirstOrThrow()
    expect(issue).toHaveBeenCalledOnce()
    expect(state).toEqual({
      status: "awaiting_deployment",
      certificateDirectoryUrl: "https://acme-v02.example/directory",
      certificateObjectVersion: "production-version",
      deployedObjectVersion: "staging-version",
    })
  })

  it("deletes the obsolete private-key version only after the replacement is acknowledged", async () => {
    vi.stubEnv("PLATFORM_EDGE_ROLLOUT_ENABLED", "1")
    await db
      .insertInto("platformEdgeCertificate")
      .values({
        id: "platform",
        status: "awaiting_deployment",
        certificateObjectKey: "platform-edge/current.json",
        certificateObjectVersion: "replacement-version",
        restartRequestedObjectVersion: "replacement-version",
        deployedObjectVersion: "obsolete-version",
        certificateIssuer: "CN=Staging Test CA",
        certificateDirectoryUrl: "https://acme-staging.example/directory",
        renewalInfoCertificateId: "aki.serial",
        certificateIssuedAt: new Date("2099-01-01T00:00:00Z"),
        certificateExpiresAt: new Date("2099-04-01T00:00:00Z"),
        nextRenewalAt: new Date("2099-03-02T00:00:00Z"),
        nextRetryAt: new Date("2099-01-01T00:00:00Z"),
      })
      .execute()
    const s3Send = vi.fn<(command: unknown) => Promise<unknown>>(() => Promise.resolve({}))
    const handler = reconcilePlatformEdgeCertificate({
      now: () => new Date("2099-01-01T00:00:00Z"),
      autoScaling: {
        send: vi.fn<(command: unknown) => Promise<unknown>>(),
      } as unknown as AutoScalingClient,
      route53: {
        send: vi.fn<(command: unknown) => Promise<unknown>>(),
      } as unknown as Route53Client,
      s3: { send: s3Send } as unknown as S3Client,
      secrets: {
        send: vi.fn<(command: unknown) => Promise<unknown>>(),
      } as unknown as SecretsManagerClient,
      valkey: {
        eval: vi.fn<(...arguments_: unknown[]) => Promise<[number, number]>>(() =>
          Promise.resolve([1, 1]),
        ),
      } as unknown as Redis,
      sleep: () => Promise.resolve(),
      issue: () => Promise.reject(new Error("unexpected issuance")),
    })

    await handler({} as never, {
      db,
      keepAlive: () => Promise.resolve(true),
      signal: new AbortController().signal,
    })

    expect(s3Send).toHaveBeenCalledOnce()
    const deletion = s3Send.mock.calls[0]?.[0]
    expect(deletion).toBeInstanceOf(DeleteObjectCommand)
    if (!(deletion instanceof DeleteObjectCommand)) throw new Error("missing version deletion")
    expect(deletion.input).toMatchObject({
      Bucket: "certificate-bucket",
      Key: "platform-edge/current.json",
      VersionId: "obsolete-version",
    })
    expect(
      await db
        .selectFrom("platformEdgeCertificate")
        .select(["status", "deployedObjectVersion"])
        .where("id", "=", "platform")
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: "active", deployedObjectVersion: "replacement-version" })
  })

  it("refreshes ARI without issuing before the selected renewal time", async () => {
    await db
      .insertInto("platformEdgeCertificate")
      .values({
        id: "platform",
        status: "active",
        certificateObjectKey: "platform-edge/current.json",
        certificateObjectVersion: "current-version",
        deployedObjectVersion: "current-version",
        certificateIssuer: "CN=Staging Test CA",
        certificateDirectoryUrl: "https://acme-staging.example/directory",
        renewalInfoCertificateId: "aki.serial",
        renewalInfoRetryAt: new Date("2099-01-01T00:00:00Z"),
        certificateIssuedAt: new Date("2098-12-01T00:00:00Z"),
        certificateExpiresAt: new Date("2099-04-01T00:00:00Z"),
        nextRenewalAt: new Date("2099-03-01T00:00:00Z"),
        nextRetryAt: new Date("2099-01-01T00:00:00Z"),
      })
      .execute()
    const refreshRenewal = vi.fn<
      (options: {
        certificateId: string
        directoryUrl: string
        expiresAt: Date
        now: Date
      }) => Promise<{
        nextRenewalAt: Date
        renewalInfoRetryAt: Date | null
        renewalInfoExplanationUrl: string | null
        source: "ari"
      }>
    >(() =>
      Promise.resolve({
        nextRenewalAt: new Date("2099-02-15T00:00:00Z"),
        renewalInfoRetryAt: new Date("2099-01-02T00:00:00Z"),
        renewalInfoExplanationUrl: "https://ca.example/current-advice",
        source: "ari",
      }),
    )
    const handler = reconcilePlatformEdgeCertificate({
      now: () => new Date("2099-01-01T00:00:00Z"),
      autoScaling: {
        send: vi.fn<(command: unknown) => Promise<unknown>>(),
      } as unknown as AutoScalingClient,
      route53: {
        send: vi.fn<(command: unknown) => Promise<unknown>>(),
      } as unknown as Route53Client,
      s3: {
        send: vi.fn<(command: unknown) => Promise<unknown>>(),
      } as unknown as S3Client,
      secrets: {
        send: vi.fn<(command: unknown) => Promise<unknown>>(),
      } as unknown as SecretsManagerClient,
      valkey: {} as Redis,
      sleep: () => Promise.resolve(),
      issue: () => Promise.reject(new Error("issued before ARI's selected time")),
      refreshRenewal,
    })

    await handler({} as never, {
      db,
      keepAlive: () => Promise.resolve(true),
      signal: new AbortController().signal,
    })

    expect(refreshRenewal).toHaveBeenCalledOnce()
    expect(
      await db
        .selectFrom("platformEdgeCertificate")
        .select(["status", "nextRenewalAt", "renewalInfoRetryAt", "nextRetryAt"])
        .where("id", "=", "platform")
        .executeTakeFirstOrThrow(),
    ).toEqual({
      status: "active",
      nextRenewalAt: new Date("2099-02-15T00:00:00Z"),
      renewalInfoRetryAt: new Date("2099-01-02T00:00:00Z"),
      nextRetryAt: new Date("2099-01-02T00:00:00Z"),
    })
  })
})
