import { Type } from "typebox"
import { Nullable, UUID7String } from "../utils/common.serializer"

export const deployStatusSchemaParam = Type.Object({
  deploymentId: UUID7String,
})

export const deployStatusSchemaResponse = Type.Object({
  deployment_id: UUID7String,
  status: Type.Union([
    Type.Literal("queued"),
    Type.Literal("building"),
    Type.Literal("deploying"),
    Type.Literal("ready"),
    Type.Literal("error"),
    Type.Literal("torn_down"),
  ]),
  failure_reason: Nullable(Type.String()),
  migration_status: Nullable(
    Type.Union([
      Type.Literal("pending"),
      Type.Literal("running"),
      Type.Literal("succeeded"),
      Type.Literal("failed"),
      Type.Literal("skipped"),
    ]),
  ),
  migration_output: Nullable(Type.String()),
  url: Nullable(Type.String()),
})
