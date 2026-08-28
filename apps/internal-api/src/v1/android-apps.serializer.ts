import { Type } from "typebox"
import { Nullable, UUID7String } from "../utils/common.serializer"

export const androidAppSchemaParam = Type.Object({
  orgSlug: Type.String(),
  projectId: UUID7String,
})

export const androidAppSchemaVerifyRequest = Type.Object({
  commit: Type.String({ pattern: "^[0-9a-f]{40}$" }),
})

const androidAppSchemaJob = Type.Object({
  id: UUID7String,
  kind: Type.Union([Type.Literal("provision_key"), Type.Literal("sign_release")]),
  state: Type.Union([
    Type.Literal("queued"),
    Type.Literal("running"),
    Type.Literal("succeeded"),
    Type.Literal("failed"),
  ]),
  error: Nullable(Type.String()),
  createdAt: Type.String({ format: "date-time" }),
})

export const androidAppSchemaResponse = Type.Object({
  androidAppId: UUID7String,
  packageName: Type.String(),
  state: Type.Union([
    Type.Literal("configuring"),
    Type.Literal("ready_for_signing"),
    Type.Literal("ready"),
    Type.Literal("failed"),
  ]),
  developerConsoleState: Type.String(),
  certificateSha256: Nullable(Type.String()),
  verifiedSetupCommit: Nullable(Type.String()),
  latestGoodDeploymentId: Nullable(UUID7String),
  lastAcceptedVersionCode: Type.Integer({ minimum: 0 }),
  lastError: Nullable(Type.String()),
  jobs: Type.Array(androidAppSchemaJob),
})
