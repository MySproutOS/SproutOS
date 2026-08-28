import { Type } from "typebox"
import { Nullable, UUID7String } from "../utils/common.serializer"

const Hostname = Type.String({
  minLength: 4,
  maxLength: 253,
  pattern: "^(?!-)[a-z0-9-]{1,63}(?<!-)(\\.(?!-)[a-z0-9-]{1,63}(?<!-))+$",
})

export const customDomainSchemaCreateRequest = Type.Object({ hostname: Hostname })

const domainStatus = Type.Union([
  Type.Literal("pending_dns"),
  Type.Literal("issuing"),
  Type.Literal("propagating"),
  Type.Literal("active"),
  Type.Literal("renewal_warning"),
  Type.Literal("failed"),
  Type.Literal("deleting"),
])

const trafficInstruction = Type.Object({
  type: Type.Union([
    Type.Literal("A"),
    Type.Literal("AAAA"),
    Type.Literal("CNAME"),
    Type.Literal("ALIAS"),
    Type.Literal("ANAME"),
  ]),
  name: Type.String(),
  value: Type.String(),
  note: Type.String(),
})

const customDomainEntry = Type.Object({
  id: UUID7String,
  project: Type.Object({ id: UUID7String, name: Type.String(), slug: Type.String() }),
  hostname: Type.String(),
  status: domainStatus,
  statusReason: Nullable(Type.String()),
  isApex: Type.Boolean(),
  verifiedAt: Nullable(Type.String({ format: "date-time" })),
  certificateExpiresAt: Nullable(Type.String({ format: "date-time" })),
  lastCheckedAt: Nullable(Type.String({ format: "date-time" })),
  nextRetryAt: Nullable(Type.String({ format: "date-time" })),
  createdAt: Type.String({ format: "date-time" }),
  instructions: Type.Object({
    verification: Type.Object({
      type: Type.Literal("TXT"),
      name: Type.String(),
      value: Type.String(),
    }),
    traffic: Type.Array(trafficInstruction),
  }),
})

export const customDomainSchemaResponse = customDomainEntry
export const customDomainSchemaListResponse = Type.Object({ data: Type.Array(customDomainEntry) })
