import { Type } from "typebox"

export const meteringSchemaResponse = Type.Object({
  /** How many events were stored, after dropping any outside the accepted clock skew. */
  accepted: Type.Integer(),
  /** How many arrived. A gap between the two is a node whose clock is wrong. */
  received: Type.Integer(),
})
