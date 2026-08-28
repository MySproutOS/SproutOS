import { DeleteObjectsCommand, ListObjectVersionsCommand, type S3Client } from "@aws-sdk/client-s3"
import { describe, expect, it } from "vitest"
import {
  activateCustomDomain,
  customDomainRetryAfter,
  deleteCertificateObjectVersions,
  deleteCustomDomain,
  hasOwnershipTxt,
  nextRenewal,
  trafficPointsToIngress,
} from "./custom-domain"

const absent = (): Promise<never> => Promise.reject(new Error("not found"))

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

describe("certificate deletion", () => {
  it("purges every private-key version and delete marker", async () => {
    const deleted: Array<{ Key?: string; VersionId?: string }> = []
    let listed = 0
    const s3 = {
      send: (command: unknown) => {
        if (command instanceof ListObjectVersionsCommand) {
          listed += 1
          return Promise.resolve(
            listed === 1
              ? {
                  Versions: [
                    { Key: "custom-domains/id/certificate.json", VersionId: "current" },
                    { Key: "custom-domains/id/certificate.json", VersionId: "prior" },
                  ],
                  DeleteMarkers: [
                    { Key: "custom-domains/id/certificate.json", VersionId: "marker" },
                  ],
                }
              : {},
          )
        }
        if (command instanceof DeleteObjectsCommand) {
          deleted.push(...(command.input.Delete?.Objects ?? []))
          return Promise.resolve({})
        }
        return Promise.reject(new Error(`unexpected ${command?.constructor.name}`))
      },
    } as unknown as Pick<S3Client, "send">

    await deleteCertificateObjectVersions(
      s3,
      "certificates",
      "custom-domains/id/certificate.json",
      "current",
    )

    expect(deleted).toEqual([
      { Key: "custom-domains/id/certificate.json", VersionId: "current" },
      { Key: "custom-domains/id/certificate.json", VersionId: "prior" },
      { Key: "custom-domains/id/certificate.json", VersionId: "marker" },
    ])
  })

  it("does not finish deletion when S3 retains a private-key version", async () => {
    const s3 = {
      send: (command: unknown) => {
        if (command instanceof ListObjectVersionsCommand) {
          return Promise.resolve({
            Versions: [{ Key: "custom-domains/id/certificate.json", VersionId: "current" }],
          })
        }
        if (command instanceof DeleteObjectsCommand) {
          return Promise.resolve({
            Errors: [
              {
                Key: "custom-domains/id/certificate.json",
                VersionId: "current",
                Code: "AccessDenied",
              },
            ],
          })
        }
        return Promise.reject(new Error(`unexpected ${command?.constructor.name}`))
      },
    } as unknown as Pick<S3Client, "send">

    await expect(
      deleteCertificateObjectVersions(
        s3,
        "certificates",
        "custom-domains/id/certificate.json",
        "current",
      ),
    ).rejects.toThrow(/current: AccessDenied/)
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
