import { Type } from "typebox"
import { Nullable, UUID7String } from "../utils/common.serializer"

export const managedDomainPolicySchemaParam = Type.Object({ policyId: UUID7String })

export const managedDomainPolicySchemaCreateRequest = Type.Object({
  suffix: Type.String({ minLength: 4, maxLength: 253 }),
  organizationId: UUID7String,
})

export const managedDomainPolicySchemaUpdateRequest = Type.Object({
  suffix: Type.Optional(Type.String({ minLength: 4, maxLength: 253 })),
  organizationId: Type.Optional(UUID7String),
  status: Type.Optional(Type.Union([Type.Literal("active"), Type.Literal("disabled")])),
})

export const managedDomainPolicySchemaResponse = Type.Object({
  id: UUID7String,
  suffix: Type.String(),
  organizationId: UUID7String,
  status: Type.Union([Type.Literal("active"), Type.Literal("disabled")]),
  createdByUserId: UUID7String,
  updatedByUserId: UUID7String,
  disabledByUserId: Nullable(UUID7String),
  createdAt: Type.String({ format: "date-time" }),
  updatedAt: Type.String({ format: "date-time" }),
  disabledAt: Nullable(Type.String({ format: "date-time" })),
})

export const managedDomainPolicySchemaListResponse = Type.Object({
  data: Type.Array(managedDomainPolicySchemaResponse),
})
