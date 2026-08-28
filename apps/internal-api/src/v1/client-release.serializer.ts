import { Type } from "typebox"

export const clientReleaseSchemaResponse = Type.Object({
  packageName: Type.Literal("me.sproutos.client"),
  versionName: Type.String(),
  versionCode: Type.Integer(),
  sha256: Type.String(),
  sizeBytes: Type.Integer(),
  certificateSha256: Type.String(),
  downloadUrl: Type.String({ format: "uri" }),
  required: Type.Optional(Type.Boolean()),
})
