import { describe, expect, it } from "vitest"
import { hasOwnershipTxt, nextRenewal, trafficPointsToIngress } from "./custom-domain"

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
})
