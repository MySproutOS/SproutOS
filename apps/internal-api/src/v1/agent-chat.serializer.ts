import { Type } from "typebox"
import { Nullable, UUID7String } from "../utils/common.serializer"

export const agentChatSchemaSessionResponse = Type.Object({
  id: UUID7String,
  title: Nullable(Type.String()),
  status: Type.String(),
  createdAt: Type.String({ format: "date-time" }),
  updatedAt: Type.String({ format: "date-time" }),
})

export const agentChatSchemaSessionListResponse = Type.Object({
  data: Type.Array(agentChatSchemaSessionResponse),
})

export const agentChatSchemaSessionCreateRequest = Type.Object({
  title: Type.Optional(Nullable(Type.String({ maxLength: 200 }))),
})

export const agentChatSchemaMessageRequest = Type.Object({
  prompt: Type.String({ minLength: 1, maxLength: 32_000 }),
})
