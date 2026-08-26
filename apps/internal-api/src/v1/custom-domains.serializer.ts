import { Type } from "typebox"
import { Nullable, UUID7String } from "../utils/common.serializer"

/**
 * A hostname is not a UUID and the difference matters here.
 *
 * Checked at the boundary because this value ends up as a Valkey key, in a certificate request, and
 * in an ALB listener — three systems with three different opinions about what is legal, none of
 * which produces a readable error. The pattern is deliberately narrow: labels of letters, digits
 * and hyphens, at least two of them, no trailing dot, no wildcard.
 *
 * Wildcards are refused rather than supported. `*.example.com` on a shared listener would let one
 * tenant's certificate answer for hostnames belonging to their own subdomains that they have not
 * claimed here — plausible-looking and impossible to reason about later.
 */
const Hostname = Type.String({
  minLength: 4,
  maxLength: 253,
  pattern: "^(?!-)[a-z0-9-]{1,63}(?<!-)(\\.(?!-)[a-z0-9-]{1,63}(?<!-))+$",
})

export const customDomainSchemaCreateRequest = Type.Object({
  hostname: Hostname,
})

const customDomainEntry = Type.Object({
  id: UUID7String,
  hostname: Type.String(),
  status: Type.String(),
  statusReason: Nullable(Type.String()),
  isApex: Type.Boolean(),
  verifiedAt: Nullable(Type.String({ format: "date-time" })),
  createdAt: Type.String({ format: "date-time" }),
  /**
   * Exactly what the customer must publish, and where.
   *
   * Returned on every read rather than only at creation. A person comes back to this screen because
   * it did not work, and the most common reason is that one of these records was mistyped — so the
   * screen has to be able to show them again, next to the status that says which step is stuck.
   */
  instructions: Type.Object({
    verification: Type.Object({
      type: Type.Literal("TXT"),
      name: Type.String(),
      value: Type.String(),
    }),
    certificate: Nullable(
      Type.Object({ type: Type.Literal("CNAME"), name: Type.String(), value: Type.String() }),
    ),
    traffic: Type.Object({
      /** `A` for an apex, which cannot hold a CNAME. That is DNS, not a platform limitation. */
      type: Type.Union([Type.Literal("A"), Type.Literal("CNAME")]),
      name: Type.String(),
      value: Type.String(),
      note: Type.String(),
    }),
  }),
})

export const customDomainSchemaResponse = customDomainEntry
export const customDomainSchemaListResponse = Type.Object({
  data: Type.Array(customDomainEntry),
})
