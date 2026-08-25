/**
 * Where a sandbox is allowed to send packets.
 *
 * `docs/findings/0009-somewhere-to-run-untrusted-code.md` is the reason this file exists, and it
 * names the one property that was ever actually verified on a live cluster: customer code pointed
 * at the instance metadata service timed out at the network policy rather than receiving the
 * node's credentials.
 *
 * ```
 * action.http   failed  exit=28
 *   out: "curl: (28) Connection timed out after 30002 milliseconds\n"
 * ```
 *
 * That policy was `0.0.0.0/0` **minus** 10/8, 172.16/12, 192.168/16 and 169.254/16. Kubernetes
 * expressed it as an exclusion; the provider's API takes an allow list, so the same rule has to be
 * written as the complement — every public range, and none of the private ones.
 *
 * ## Why the list is generated rather than written
 *
 * A CIDR complement is exactly the kind of thing that looks right and is not. `169.254.0.0/16`
 * removed from `0.0.0.0/0` is seven networks, not one, and a hand-written approximation
 * (`169.0.0.0/8` left whole, say) re-admits link-local without looking like it does. So this list
 * came out of `ipaddress.ip_network(...).address_exclude(...)` over the blocked set below, and
 * `egress.test.ts` checks the property — that specific addresses are and are not covered — rather
 * than comparing the string to itself.
 *
 * Excluded beyond finding 0009's four: loopback, `0.0.0.0/8`, carrier-grade NAT (`100.64/10`,
 * which is where a cloud's own service endpoints often live), IETF protocol assignments,
 * benchmarking, multicast and reserved space. Each is somewhere a packet from customer code has no
 * legitimate reason to go, and one of them is where the next metadata service will turn up.
 */

/** What the allow list is the complement of. Kept beside it so the intent survives a regeneration. */
export const BLOCKED_RANGES = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "224.0.0.0/4",
  "240.0.0.0/4",
] as const

/**
 * Every IPv4 range a sandbox may reach: `0.0.0.0/0` minus {@link BLOCKED_RANGES}.
 *
 * Regenerate with:
 *
 * ```python
 * import ipaddress
 * out = [ipaddress.ip_network("0.0.0.0/0")]
 * for b in BLOCKED_RANGES:
 *     nb = ipaddress.ip_network(b)
 *     out = [x for n in out for x in (n.address_exclude(nb) if nb.subnet_of(n) else ([] if n.subnet_of(nb) else [n]))]
 * print(",".join(str(n) for n in sorted(out, key=lambda n: (int(n.network_address), n.prefixlen))))
 * ```
 */
export const PUBLIC_IPV4_RANGES = [
  "1.0.0.0/8",
  "2.0.0.0/7",
  "4.0.0.0/6",
  "8.0.0.0/7",
  "11.0.0.0/8",
  "12.0.0.0/6",
  "16.0.0.0/4",
  "32.0.0.0/3",
  "64.0.0.0/3",
  "96.0.0.0/6",
  "100.0.0.0/10",
  "100.128.0.0/9",
  "101.0.0.0/8",
  "102.0.0.0/7",
  "104.0.0.0/5",
  "112.0.0.0/5",
  "120.0.0.0/6",
  "124.0.0.0/7",
  "126.0.0.0/8",
  "128.0.0.0/3",
  "160.0.0.0/5",
  "168.0.0.0/8",
  "169.0.0.0/9",
  "169.128.0.0/10",
  "169.192.0.0/11",
  "169.224.0.0/12",
  "169.240.0.0/13",
  "169.248.0.0/14",
  "169.252.0.0/15",
  "169.255.0.0/16",
  "170.0.0.0/7",
  "172.0.0.0/12",
  "172.32.0.0/11",
  "172.64.0.0/10",
  "172.128.0.0/9",
  "173.0.0.0/8",
  "174.0.0.0/7",
  "176.0.0.0/4",
  "192.0.1.0/24",
  "192.0.2.0/23",
  "192.0.4.0/22",
  "192.0.8.0/21",
  "192.0.16.0/20",
  "192.0.32.0/19",
  "192.0.64.0/18",
  "192.0.128.0/17",
  "192.1.0.0/16",
  "192.2.0.0/15",
  "192.4.0.0/14",
  "192.8.0.0/13",
  "192.16.0.0/12",
  "192.32.0.0/11",
  "192.64.0.0/10",
  "192.128.0.0/11",
  "192.160.0.0/13",
  "192.169.0.0/16",
  "192.170.0.0/15",
  "192.172.0.0/14",
  "192.176.0.0/12",
  "192.192.0.0/10",
  "193.0.0.0/8",
  "194.0.0.0/7",
  "196.0.0.0/7",
  "198.0.0.0/12",
  "198.16.0.0/15",
  "198.20.0.0/14",
  "198.24.0.0/13",
  "198.32.0.0/11",
  "198.64.0.0/10",
  "198.128.0.0/9",
  "199.0.0.0/8",
  "200.0.0.0/5",
  "208.0.0.0/4",
] as const

/** The provider takes one comma-separated string. */
export const EGRESS_ALLOW_LIST = PUBLIC_IPV4_RANGES.join(",")
