/**
 * Select the repository-built log extension for one project.
 *
 * This is an operational rollout switch rather than a product feature flag. A Lambda layer is
 * copied into an immutable function version, so attaching a newly published observability binary
 * to every customer at once would make rollback require republishing every function. Default off,
 * then a project allowlist, gives us a real invocation before the platform-wide switch moves.
 */
export function logExtensionLayerForProject(
  projectId: string,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const arn = environment.LOG_EXTENSION_LAYER_ARN?.trim()
  if (arn === undefined || arn === "") return undefined

  if (environment.LOG_EXTENSION_ENABLED?.trim().toLowerCase() === "true") return arn

  const canaries = new Set(
    (environment.LOG_EXTENSION_CANARY_PROJECT_IDS ?? "")
      .split(",")
      .map((candidate) => candidate.trim())
      .filter(Boolean),
  )
  return canaries.has(projectId) ? arn : undefined
}
