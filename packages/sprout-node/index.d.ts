export type ApplyTemplateInput = {
  workspacePath: string
  pluginReference: string
  pluginDigest: `sha256:${string}`
  deploymentTemplatesCommit: string
  request: Record<string, unknown>
}

export type TemplateWorkspaceChange = {
  path: string
  kind: "create" | "modify" | "delete"
  size: number
  before_sha256: string | null
  sha256: string | null
}

export type ApplyTemplateResult = {
  protocol: {
    declared_changes: Array<Record<string, unknown>>
    response: Record<string, unknown>
  }
  changes: TemplateWorkspaceChange[]
}

export class SproutNodeError extends Error {
  readonly code: string
  readonly retryable: boolean
}

export function applyTemplate(input: ApplyTemplateInput): Promise<ApplyTemplateResult>
export function nativeRuntimeStatus(): { available: true; pluginTarget: string }
