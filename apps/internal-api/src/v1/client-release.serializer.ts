import { Type } from "typebox"

export const clientReleaseSchemaResponse = Type.Object({
  packageName: Type.Literal("com.sproutos.store"),
  versionName: Type.String({ minLength: 1, maxLength: 100 }),
  versionCode: Type.Integer({ minimum: 1, maximum: 2_100_000_000 }),
  sha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  sizeBytes: Type.Integer({ minimum: 1 }),
  certificateSha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  downloadUrl: Type.String({ format: "uri" }),
  required: Type.Optional(Type.Boolean()),
})
