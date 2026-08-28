import {
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3"
import type { SecretsManagerClient } from "@aws-sdk/client-secrets-manager"
import { crudCustomDomain } from "@lib/dao"
import { db } from "@sproutos/db"
import { sql } from "kysely"
import type { Redis } from "ioredis"
import { v7 } from "uuid"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import {
  activateCustomDomain,
  customDomainRetryAfter,
  deleteCustomDomain,
  hasOwnershipTxt,
  nextRenewal,
  reconcileCustomDomain,
  trafficPointsToIngress,
} from "./custom-domain"

const absent = (): Promise<never> => Promise.reject(new Error("not found"))
const databaseReachable = await (async () => {
  try {
    await sql`select 1`.execute(db)
    return true
  } catch {
    return false
  }
})()

describe("custom-domain DNS checks", () => {
  it("joins split TXT chunks before comparing the ownership proof", async () => {
    const resolver = {
      resolveTxt: () => Promise.resolve([["sproutos-domain-", "verification=abc"]]),
      resolve4: absent,
      resolve6: absent,
      resolveCname: absent,
    }
    expect(await hasOwnershipTxt(resolver, "example.com", "sproutos-domain-verification=abc")).toBe(
      true,
    )
  })

  it("accepts the exact ingress CNAME and rejects a lookalike suffix", async () => {
    const exact = {
      resolveTxt: absent,
      resolve4: absent,
      resolve6: absent,
      resolveCname: () => Promise.resolve(["ingress.sproutos.run."]),
    }
    const lookalike = {
      ...exact,
      resolveCname: () => Promise.resolve(["ingress.sproutos.run.attacker.example."]),
    }
    expect(await trafficPointsToIngress(exact, "app.example.com", "ingress.sproutos.run")).toBe(
      true,
    )
    expect(await trafficPointsToIngress(lookalike, "app.example.com", "ingress.sproutos.run")).toBe(
      false,
    )
  })

  it("accepts flattened apex records only when an address intersects", async () => {
    const resolver = {
      resolveTxt: absent,
      resolveCname: absent,
      resolve4: (hostname: string) =>
        Promise.resolve(
          hostname === "example.com" ? ["203.0.113.10"] : ["203.0.113.10", "203.0.113.11"],
        ),
      resolve6: () => Promise.resolve([]),
    }
    expect(await trafficPointsToIngress(resolver, "example.com", "ingress.sproutos.run")).toBe(true)
  })
})

describe("certificate renewal fallback", () => {
  it("derives the window from the actual expiry rather than assuming a lifetime", () => {
    expect(nextRenewal(new Date("2027-01-31T00:00:00.000Z"))).toEqual(
      new Date("2027-01-01T00:00:00.000Z"),
    )
  })

  it("backs failures off durably and caps retries", () => {
    const now = new Date("2026-08-28T00:00:00Z")
    expect(customDomainRetryAfter(now, 1)).toEqual(new Date("2026-08-28T00:02:00Z"))
    expect(customDomainRetryAfter(now, 100)).toEqual(new Date("2026-08-28T17:04:00Z"))
  })
})

describe("custom-domain activation ordering", () => {
  it("publishes the route before marking the domain active", async () => {
    const routeKeys = new Set<string>()
    const order: string[] = []

    await activateCustomDomain({
      publishRoute: () => {
        routeKeys.add("route:app.example.com")
        order.push("route")
        return Promise.resolve()
      },
      clearPending: () => {
        order.push("pending")
        return Promise.resolve()
      },
      markActive: () => {
        expect(routeKeys.has("route:app.example.com")).toBe(true)
        order.push("active")
        return Promise.resolve()
      },
    })

    expect(order).toEqual(["route", "pending", "active"])
  })

  it("never marks active when route publication fails", async () => {
    let markedActive = false
    await expect(
      activateCustomDomain({
        publishRoute: () => Promise.reject(new Error("Valkey unavailable")),
        clearPending: () => Promise.resolve(),
        markActive: () => {
          markedActive = true
          return Promise.resolve()
        },
      }),
    ).rejects.toThrow("Valkey unavailable")
    expect(markedActive).toBe(false)
  })

  it("removes the obsolete private-key version before declaring the replacement active", async () => {
    const order: string[] = []
    await activateCustomDomain({
      publishRoute: () => {
        order.push("route")
        return Promise.resolve()
      },
      clearPending: () => {
        order.push("pending")
        return Promise.resolve()
      },
      cleanupObsolete: () => {
        order.push("cleanup")
        return Promise.resolve()
      },
      markActive: () => {
        order.push("active")
        return Promise.resolve()
      },
    })
    expect(order).toEqual(["route", "pending", "cleanup", "active"])
  })
})

describe("custom-domain deletion ordering", () => {
  it("withdraws both request-path keys before deleting private-key material", async () => {
    const order: string[] = []
    await deleteCustomDomain({
      withdrawRoute: () => {
        order.push("route")
        return Promise.resolve()
      },
      clearPending: () => {
        order.push("pending")
        return Promise.resolve()
      },
      deleteObjects: () => {
        expect(order).toEqual(["route", "pending"])
        order.push("objects")
        return Promise.resolve()
      },
      invalidateCertificates: () => {
        order.push("invalidate")
        return Promise.resolve()
      },
      finishDelete: () => {
        order.push("database")
        return Promise.resolve()
      },
    })
    expect(order).toEqual(["route", "pending", "objects", "invalidate", "database"])
  })

  it("recovers idempotently after a crash between withdrawal and object cleanup", async () => {
    const routes = new Set(["app.example.com"])
    const pending = new Set(["app.example.com"])
    const objects = new Set(["version-1"])
    let first = true
    let finished = false
    const run = () =>
      deleteCustomDomain({
        withdrawRoute: () => {
          routes.delete("app.example.com")
          return Promise.resolve()
        },
        clearPending: () => {
          pending.delete("app.example.com")
          return Promise.resolve()
        },
        deleteObjects: () => {
          if (first) {
            first = false
            return Promise.reject(new Error("worker crashed"))
          }
          objects.delete("version-1")
          return Promise.resolve()
        },
        invalidateCertificates: () => Promise.resolve(),
        finishDelete: () => {
          finished = true
          return Promise.resolve()
        },
      })

    await expect(run()).rejects.toThrow("worker crashed")
    expect([...routes]).toEqual([])
    expect([...pending]).toEqual([])
    expect([...objects]).toEqual(["version-1"])
    expect(finished).toBe(false)

    await expect(run()).resolves.toBeUndefined()
    expect([...routes]).toEqual([])
    expect([...pending]).toEqual([])
    expect([...objects]).toEqual([])
    expect(finished).toBe(true)
  })
})

describe.runIf(databaseReachable)("custom-domain deletion recovery", () => {
  const userId = v7()
  const organizationId = v7()
  const repositoryId = v7()
  const projectId = v7()
  const domainId = v7()
  const issuingDomainId = v7()
  const crashingDomainId = v7()

  beforeAll(async () => {
    await db
      .insertInto("user")
      .values({ id: userId, email: `${userId}@example.test` })
      .execute()
    await db
      .insertInto("organization")
      .values({
        id: organizationId,
        slug: `delete-recovery-${organizationId}`,
        name: "Delete recovery",
        kind: "personal",
        ownerUserId: userId,
      })
      .execute()
    await db
      .insertInto("repository")
      .values({
        id: repositoryId,
        organizationId,
        githubRepoId: Date.now() + 1,
        ownerLogin: "test",
        name: `delete-recovery-${repositoryId}`,
        provenance: "new",
      })
      .execute()
    await db
      .insertInto("project")
      .values({
        id: projectId,
        organizationId,
        repositoryId,
        name: "Delete recovery",
        slug: `delete-recovery-${projectId}`,
      })
      .execute()
    await db
      .insertInto("customDomain")
      .values({
        id: domainId,
        organizationId,
        projectId,
        hostname: `${domainId}.example.test`,
        verificationToken: "proof",
      })
      .execute()
    await db
      .insertInto("customDomain")
      .values({
        id: crashingDomainId,
        organizationId,
        projectId,
        hostname: `${crashingDomainId}.example.test`,
        verificationToken: "proof",
        status: "active",
        certificateObjectKey: `custom-domains/${crashingDomainId}/current.json`,
        certificateObjectVersion: "old-version",
        deployedCertificateObjectKey: `custom-domains/${crashingDomainId}/current.json`,
        deployedCertificateObjectVersion: "old-version",
        certificateIssuer: "CN=Staging Test CA",
        certificateDirectoryUrl: "https://acme-staging.example/directory",
        renewalInfoCertificateId: "aki.serial",
        certificateIssuedAt: new Date("2026-01-01T00:00:00Z"),
        certificateExpiresAt: new Date("2026-09-01T00:00:00Z"),
        nextRenewalAt: new Date("2026-08-01T00:00:00Z"),
        nextRetryAt: new Date("2026-08-01T00:00:00Z"),
      })
      .execute()
    await crudCustomDomain(db).beginDelete(organizationId, domainId)
    await db
      .insertInto("customDomain")
      .values({
        id: issuingDomainId,
        organizationId,
        projectId,
        hostname: `${issuingDomainId}.example.test`,
        verificationToken: "proof",
        status: "active",
        certificateObjectKey: `custom-domains/${issuingDomainId}/current.json`,
        certificateObjectVersion: "old-version",
        deployedCertificateObjectKey: `custom-domains/${issuingDomainId}/current.json`,
        deployedCertificateObjectVersion: "old-version",
        certificateIssuer: "CN=Staging Test CA",
        certificateDirectoryUrl: "https://acme-staging.example/directory",
        renewalInfoCertificateId: "aki.serial",
        certificateIssuedAt: new Date("2026-01-01T00:00:00Z"),
        certificateExpiresAt: new Date("2026-09-01T00:00:00Z"),
        nextRenewalAt: new Date("2026-08-01T00:00:00Z"),
        nextRetryAt: new Date("2026-08-01T00:00:00Z"),
      })
      .execute()
  })

  afterAll(async () => {
    await db.deleteFrom("organization").where("id", "=", organizationId).execute()
    await db.deleteFrom("user").where("id", "=", userId).execute()
    await db.destroy()
  })

  it("keeps deleting durable when route withdrawal crashes", async () => {
    const handler = reconcileCustomDomain({
      withdrawRoute: () => Promise.reject(new Error("Valkey unavailable during withdrawal")),
    })
    await expect(
      handler({ payload: { domainId } } as never, {
        db,
        keepAlive: () => Promise.resolve(true),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("Valkey unavailable during withdrawal")

    const deleting = await db
      .selectFrom("customDomain")
      .select(["status", "reconcileLeaseToken", "nextRetryAt"])
      .where("id", "=", domainId)
      .executeTakeFirstOrThrow()
    expect(deleting.status).toBe("deleting")
    expect(deleting.reconcileLeaseToken).toBeNull()
    expect(deleting.nextRetryAt).toBeInstanceOf(Date)
  })

  it("deletes an initial-issuance object that crashed before its DB version was recorded", async () => {
    vi.stubEnv("TENANT_CERTIFICATE_BUCKET", "certificates")
    try {
      let listedPrefix: string | undefined
      const s3Send = vi.fn<(command: unknown) => Promise<unknown>>((command) => {
        if (command instanceof ListObjectVersionsCommand) {
          listedPrefix = command.input.Prefix
          return Promise.resolve({
            Versions: [
              {
                Key: `custom-domains/${domainId}/current.json`,
                VersionId: "untracked-first-issuance",
              },
            ],
          })
        }
        return Promise.resolve({})
      })
      const handler = reconcileCustomDomain({
        withdrawRoute: () => Promise.resolve(),
        s3: { send: s3Send } as unknown as S3Client,
        valkey: {
          del: vi.fn<(key: string) => Promise<number>>(() => Promise.resolve(1)),
          publish: vi.fn<(channel: string, message: string) => Promise<number>>(() =>
            Promise.resolve(1),
          ),
        } as unknown as Redis,
      })
      await expect(
        handler({ payload: { domainId } } as never, {
          db,
          keepAlive: () => Promise.resolve(true),
          signal: new AbortController().signal,
        }),
      ).resolves.toBeUndefined()

      expect(listedPrefix).toBe(`custom-domains/${domainId}/current.json`)
      expect(
        s3Send.mock.calls.some(
          ([command]) =>
            command instanceof DeleteObjectsCommand &&
            command.input.Delete?.Objects?.some(
              (object) => object.VersionId === "untracked-first-issuance",
            ) === true,
        ),
      ).toBe(true)
      const deleted = await db
        .selectFrom("customDomain")
        .select("deletedAt")
        .where("id", "=", domainId)
        .executeTakeFirstOrThrow()
      expect(deleted.deletedAt).toBeInstanceOf(Date)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("fences an issuance paused across beginDelete before it stores a private key", async () => {
    vi.stubEnv("TENANT_CERTIFICATE_BUCKET", "certificates")
    vi.stubEnv("TENANT_CERTIFICATE_KMS_KEY_ARN", "kms-key")
    vi.stubEnv("ACME_DIRECTORY_URL", "https://acme-staging.example/directory")
    let releaseIssue!: () => void
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const issueGate = new Promise<void>((resolve) => {
      releaseIssue = resolve
    })
    const publishRoute = vi.fn<() => Promise<void>>(() => Promise.resolve())
    const valkeyPublish = vi.fn<() => Promise<number>>(() => Promise.resolve(1))
    const s3Send = vi.fn<(command: unknown) => Promise<unknown>>(() => Promise.resolve({}))
    const handler = reconcileCustomDomain({
      now: () => new Date("2026-08-28T00:00:00Z"),
      issue: async () => {
        markStarted()
        await issueGate
        return {
          certificatePem: "certificate",
          privateKeyPem: "private-key",
          issuedAt: new Date("2026-08-28T00:00:00Z"),
          expiresAt: new Date("2026-11-28T00:00:00Z"),
        }
      },
      scheduleIssued: () =>
        Promise.resolve({
          certificateId: "aki.new",
          issuer: "CN=Staging Test CA",
          nextRenewalAt: new Date("2026-10-28T00:00:00Z"),
          renewalInfoRetryAt: null,
          renewalInfoExplanationUrl: null,
          source: "unsupported",
        }),
      publishRoute,
      s3: { send: s3Send } as unknown as S3Client,
      secrets: {
        send: vi.fn<(command: unknown) => Promise<unknown>>(() => Promise.resolve({})),
      } as unknown as SecretsManagerClient,
      valkey: {
        set: vi.fn<(key: string, value: string, ...arguments_: string[]) => Promise<"OK">>(() =>
          Promise.resolve("OK"),
        ),
        del: vi.fn<(key: string) => Promise<number>>(() => Promise.resolve(1)),
        publish: valkeyPublish,
      } as unknown as Redis,
    })
    const running = handler({ payload: { domainId: issuingDomainId } } as never, {
      db,
      keepAlive: () => Promise.resolve(true),
      signal: new AbortController().signal,
    })
    await started
    await crudCustomDomain(db).beginDelete(organizationId, issuingDomainId)
    releaseIssue()
    await expect(running).resolves.toBeUndefined()

    expect(publishRoute).not.toHaveBeenCalled()
    expect(valkeyPublish).not.toHaveBeenCalled()
    expect(s3Send.mock.calls.some(([command]) => command instanceof PutObjectCommand)).toBe(false)
    expect(
      await db
        .selectFrom("customDomain")
        .select(["status", "certificateObjectVersion", "reconcileLeaseToken"])
        .where("id", "=", issuingDomainId)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      status: "deleting",
      certificateObjectVersion: "old-version",
      reconcileLeaseToken: null,
    })
    vi.unstubAllEnvs()
  })

  it("makes deletion wait across the S3-to-database crash window, then removes the new version", async () => {
    vi.stubEnv("TENANT_CERTIFICATE_BUCKET", "certificates")
    vi.stubEnv("TENANT_CERTIFICATE_KMS_KEY_ARN", "kms-key")
    vi.stubEnv("ACME_DIRECTORY_URL", "https://acme-staging.example/directory")
    try {
      let releaseCrash!: () => void
      let markStored!: () => void
      const stored = new Promise<void>((resolve) => {
        markStored = resolve
      })
      const crashGate = new Promise<void>((resolve) => {
        releaseCrash = resolve
      })
      const versions = new Set(["old-version"])
      const objectKey = `custom-domains/${crashingDomainId}/current.json`
      const s3Send = vi.fn<(command: unknown) => Promise<unknown>>((command) => {
        if (command instanceof PutObjectCommand) {
          versions.add("crash-version")
          return Promise.resolve({ VersionId: "crash-version" })
        }
        if (command instanceof ListObjectVersionsCommand) {
          return Promise.resolve({
            Versions: [...versions].map((VersionId) => ({ Key: objectKey, VersionId })),
          })
        }
        if (command instanceof DeleteObjectsCommand) {
          for (const object of command.input.Delete?.Objects ?? []) {
            if (object.VersionId !== undefined) versions.delete(object.VersionId)
          }
          return Promise.resolve({})
        }
        return Promise.resolve({})
      })
      const valkey = {
        set: vi.fn<() => Promise<"OK">>(() => Promise.resolve("OK")),
        del: vi.fn<() => Promise<number>>(() => Promise.resolve(1)),
        publish: vi.fn<() => Promise<number>>(() => Promise.resolve(1)),
      } as unknown as Redis
      const issuing = reconcileCustomDomain({
        now: () => new Date("2026-08-28T00:00:00Z"),
        issue: () =>
          Promise.resolve({
            certificatePem: "certificate",
            privateKeyPem: "private-key",
            issuedAt: new Date("2026-08-28T00:00:00Z"),
            expiresAt: new Date("2026-11-28T00:00:00Z"),
          }),
        scheduleIssued: () =>
          Promise.resolve({
            certificateId: "aki.crash",
            issuer: "CN=Staging Test CA",
            nextRenewalAt: new Date("2026-10-28T00:00:00Z"),
            renewalInfoRetryAt: null,
            renewalInfoExplanationUrl: null,
            source: "unsupported",
          }),
        afterCertificateStored: async () => {
          markStored()
          await crashGate
          throw new Error("simulated process death after S3 PutObject")
        },
        s3: { send: s3Send } as unknown as S3Client,
        valkey,
      })({ payload: { domainId: crashingDomainId } } as never, {
        db,
        keepAlive: () => Promise.resolve(true),
        signal: new AbortController().signal,
      })

      await stored
      let deleteCompleted = false
      const beginDelete = crudCustomDomain(db)
        .beginDelete(organizationId, crashingDomainId)
        .then((result) => {
          deleteCompleted = true
          return result
        })
      await new Promise((resolve) => setTimeout(resolve, 25))
      expect(deleteCompleted).toBe(false)

      releaseCrash()
      await Promise.allSettled([issuing, beginDelete])
      expect(deleteCompleted).toBe(true)
      expect(versions.has("crash-version")).toBe(true)

      await expect(
        reconcileCustomDomain({
          withdrawRoute: () => Promise.resolve(),
          s3: { send: s3Send } as unknown as S3Client,
          valkey,
        })({ payload: { domainId: crashingDomainId } } as never, {
          db,
          keepAlive: () => Promise.resolve(true),
          signal: new AbortController().signal,
        }),
      ).resolves.toBeUndefined()

      expect(versions).toEqual(new Set())
      const deleted = await db
        .selectFrom("customDomain")
        .select("deletedAt")
        .where("id", "=", crashingDomainId)
        .executeTakeFirstOrThrow()
      expect(deleted.deletedAt).toBeInstanceOf(Date)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
