import { describe, expect, it } from "vitest"
import {
  activateCustomDomain,
  customDomainRetryAfter,
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
})
