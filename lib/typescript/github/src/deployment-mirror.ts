export const DEPLOYMENT_INSTRUCTION_PATHS = [
  "SPROUT_OS_DEPLOY.md",
  ".config/SPROUT_OS_DEPLOY.md",
] as const

export async function findDeploymentInstructions(
  input: { owner: string; repo: string; branch: string },
  fetcher: typeof fetch = fetch,
): Promise<(typeof DEPLOYMENT_INSTRUCTION_PATHS)[number] | null> {
  if (input.owner !== "SproutOS-Apps") return null

  const results = await Promise.all(
    DEPLOYMENT_INSTRUCTION_PATHS.map(async (path) => {
      const url = `https://raw.githubusercontent.com/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/${encodeURIComponent(input.branch)}/${path}`
      try {
        const response = await fetcher(url, { method: "GET", redirect: "error" })
        return response.ok && (await response.text()).trim() !== "" ? path : null
      } catch {
        return null
      }
    }),
  )
  return results.find((path) => path !== null) ?? null
}

type CompareResponse = {
  behind_by?: unknown
  files?: { filename?: unknown; status?: unknown }[]
}

export async function verifyDeploymentMirror(
  input: { upstreamOwner: string; mirrorOwner: string; repo: string; branch: string },
  fetcher: typeof fetch = fetch,
): Promise<(typeof DEPLOYMENT_INSTRUCTION_PATHS)[number] | null> {
  if (input.mirrorOwner !== "SproutOS-Apps") return null

  const compareUrl =
    `https://api.github.com/repos/${encodeURIComponent(input.mirrorOwner)}/${encodeURIComponent(input.repo)}/compare/` +
    `${encodeURIComponent(input.upstreamOwner)}:${encodeURIComponent(input.branch)}...${encodeURIComponent(input.branch)}`
  let comparison: CompareResponse
  try {
    const response = await fetcher(compareUrl, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "SproutOS" },
      redirect: "error",
    })
    if (!response.ok) return null
    comparison = (await response.json()) as CompareResponse
  } catch {
    return null
  }

  if (comparison.behind_by !== 0 || comparison.files?.length !== 1) return null
  const [difference] = comparison.files
  if (
    typeof difference?.filename !== "string" ||
    !DEPLOYMENT_INSTRUCTION_PATHS.includes(
      difference.filename as (typeof DEPLOYMENT_INSTRUCTION_PATHS)[number],
    ) ||
    (difference.status !== "added" && difference.status !== "modified")
  ) {
    return null
  }

  return await findDeploymentInstructions(
    { owner: input.mirrorOwner, repo: input.repo, branch: input.branch },
    fetcher,
  )
}
