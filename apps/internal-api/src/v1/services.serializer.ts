import { Type } from "typebox"
import { Nullable, UUID7String } from "../utils/common.serializer"

export const SERVICE_KINDS = ["postgres", "valkey", "elasticsearch"] as const

/**
 * Never carries a connection URI.
 *
 * The URI holds a password, and a list endpoint is the wrong place for one: it is cached by
 * clients, logged by proxies, and rendered on a page nobody meant to expose. Revealing is a
 * separate, audited POST.
 */
export const servicesSchemaService = Type.Object({
  id: UUID7String,
  name: Type.String(),
  kind: Type.Union(SERVICE_KINDS.map((kind) => Type.Literal(kind))),
  status: Type.String(),
  projectId: Nullable(UUID7String),
  /** Everything about the connection except the secret. */
  host: Nullable(Type.String()),
  port: Nullable(Type.Number()),
  database: Nullable(Type.String()),
  username: Nullable(Type.String()),
  createdAt: Type.String({ format: "date-time" }),
})

export const servicesSchemaListResponse = Type.Object({
  data: Type.Array(servicesSchemaService),
})

export const servicesSchemaCreateRequest = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 80 }),
  kind: Type.Union(SERVICE_KINDS.map((kind) => Type.Literal(kind))),
  /** Omit for a standalone service — TASK 37's whole point. */
  projectId: Type.Optional(Nullable(UUID7String)),
})

/** The one response that carries a credential, returned once at creation and on explicit reveal. */
export const servicesSchemaConnectionResponse = Type.Object({
  id: UUID7String,
  connectionUri: Type.String(),
})

export const servicesSchemaIdParam = Type.Object({
  orgSlug: Type.String(),
  serviceId: UUID7String,
})
