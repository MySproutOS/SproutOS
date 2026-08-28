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

export const clientReleaseSchemaRequest = Type.Object({
  package_name: Type.Literal("me.sproutos.client"),
  version_name: Type.String({ minLength: 1, maxLength: 100 }),
  version_code: Type.Integer({ minimum: 1 }),
  apk_object_key: Type.String({ minLength: 1, maxLength: 1024 }),
  apk_object_version: Type.String({ minLength: 1, maxLength: 1024 }),
  apk_sha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  apk_size_bytes: Type.Integer({ minimum: 1 }),
  certificate_sha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  required: Type.Optional(Type.Boolean()),
})

export const clientReleasePublishSchemaResponse = Type.Object({
  id: Type.String({ format: "uuid" }),
})
