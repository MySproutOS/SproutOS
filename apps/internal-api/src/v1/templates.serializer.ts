import { Type } from "typebox"

const templateTarget = Type.Union([
  Type.Literal("linux_amd64_musl"),
  Type.Literal("linux_arm64_musl"),
  Type.Literal("darwin_amd64"),
  Type.Literal("darwin_arm64"),
  Type.Literal("windows_amd64"),
])

export const templateSchemaResolveRequest = Type.Object({
  template_id: Type.String({ minLength: 1, maxLength: 128 }),
  upstream_commit: Type.String({ pattern: "^[0-9a-f]{40}$" }),
  target: templateTarget,
})

export const templateSchemaResolveResponse = Type.Object({
  template_id: Type.String(),
  upstream_commit: Type.String(),
  plugin_reference: Type.String(),
  plugin_digest: Type.String(),
  target: templateTarget,
  provenance: Type.Object({
    repository: Type.String(),
    workflow: Type.String(),
    git_ref: Type.String(),
    source_commit: Type.String(),
    oidc_issuer: Type.String(),
    workflow_identity: Type.String(),
    github_hosted_runner: Type.Boolean(),
  }),
  request: Type.Object({}, { additionalProperties: true }),
})
