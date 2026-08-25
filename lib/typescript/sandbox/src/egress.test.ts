import { describe, expect, it } from "vitest"
import { BLOCKED_RANGES, EGRESS_ALLOW_LIST, PUBLIC_IPV4_RANGES } from "./egress"

/**
 * The property, not the string.
 *
 * Comparing {@link PUBLIC_IPV4_RANGES} to a copy of itself is the shape of check
 * `docs/findings/0001-checks-that-do-not-check.md` is about. What matters is which addresses the
 * list covers, so that is what is asserted — by deciding containment here, in eight lines of
 * arithmetic, rather than by trusting the generator that produced the list.
 */
function toInt(ip: string): number {
  const parts = ip.split(".").map(Number)
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    throw new Error(`Not an IPv4 address: ${ip}`)
  }
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]
}

function covers(cidr: string, ip: string): boolean {
  const [network, bits] = cidr.split("/")
  const width = Number(bits)
  const mask = width === 0 ? 0 : (0xffffffff << (32 - width)) >>> 0
  return (toInt(network) & mask) >>> 0 === (toInt(ip) & mask) >>> 0
}

const allowed = (ip: string) => PUBLIC_IPV4_RANGES.some((r) => covers(r, ip))

describe("egress allow list", () => {
  it("refuses the instance metadata service", () => {
    // The one property finding 0009 verified live, and the reason any of this exists.
    expect(allowed("169.254.169.254")).toBe(false)
  })

  it.each([
    ["RFC1918 ten", "10.0.0.1"],
    ["RFC1918 ten, high", "10.255.255.254"],
    ["RFC1918 172", "172.16.0.1"],
    ["RFC1918 172, high", "172.31.255.254"],
    ["RFC1918 192.168", "192.168.1.1"],
    ["link-local", "169.254.0.1"],
    ["loopback", "127.0.0.1"],
    ["this network", "0.0.0.0"],
    ["carrier-grade NAT", "100.64.0.1"],
    ["multicast", "224.0.0.1"],
    ["reserved", "240.0.0.1"],
  ])("refuses %s", (_name, ip) => {
    expect(allowed(ip)).toBe(false)
  })

  it.each([
    ["Cloudflare DNS", "1.1.1.1"],
    ["Google DNS", "8.8.8.8"],
    ["npm", "104.16.0.1"],
    ["GitHub", "140.82.121.4"],
    ["an address just outside 172.16/12", "172.32.0.1"],
    ["an address just below 172.16/12", "172.15.255.254"],
    ["an address just outside 169.254/16", "169.255.0.1"],
    ["an address just below 169.254/16", "169.253.255.254"],
    ["an address just outside 192.168/16", "192.169.0.1"],
    ["an address just below 192.168/16", "192.167.255.254"],
  ])("allows %s", (_name, ip) => {
    expect(allowed(ip)).toBe(true)
  })

  it("allows and blocks are exhaustive and disjoint", () => {
    /*
      Every address is in exactly one of the two sets. Sampling the boundaries of each blocked
      range catches both failure directions at once: a range left in the allow list by mistake, and
      a gap where an address belongs to neither.
    */
    for (const blocked of BLOCKED_RANGES) {
      const [network, bits] = blocked.split("/")
      const width = Number(bits)
      const size = width === 32 ? 1 : 2 ** (32 - width)
      const base = toInt(network)
      for (const offset of [0, 1, size - 1]) {
        const addr = base + offset
        const ip = [24, 16, 8, 0].map((s) => (addr >>> s) & 255).join(".")
        expect(allowed(ip), `${ip} is inside blocked ${blocked}`).toBe(false)
      }
    }
  })

  it("serialises to the comma-separated form the provider takes", () => {
    expect(EGRESS_ALLOW_LIST.split(",")).toHaveLength(PUBLIC_IPV4_RANGES.length)
    expect(EGRESS_ALLOW_LIST).not.toContain(" ")
  })
})
