import { Type } from "typebox"
import { Nullable, UUID7String } from "../utils/common.serializer"

const Hostname = Type.String({
  minLength: 4,
  // Unicode and case normalization happen before the hostname is stored. The A-label result has
  // the DNS length/label checks; rejecting here would prevent a valid `bücher.example` request from
  // ever reaching that normalization.
  maxLength: 1_024,
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
