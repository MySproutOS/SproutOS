/**
 * `owner/repo`, however somebody happens to paste it.
 *
 * People paste the browser URL far more often than they type the short form, and a field that
 * accepts only one of those is a field that rejects the thing the user actually has in their
 * clipboard. `.git` suffixes and trailing slashes come along with clone URLs.
 */
export function parseRepoRef(input: string): { owner: string; repo: string } | null {
  const trimmed = input
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "")

  const parts = trimmed.split("/")
  if (parts.length !== 2) return null

  const [owner, repo] = parts
  if (owner === undefined || repo === undefined) return null
  if (owner === "" || repo === "") return null
  if (!/^[A-Za-z0-9-]+$/.test(owner)) return null
  if (!/^[A-Za-z0-9._-]+$/.test(repo)) return null

  return { owner, repo }
}

/** `name`, `name-2`, `name-3` — the first that nothing in `taken` already answers to. */
export function nextFreeName(name: string, taken: { name: string }[]): string {
  const used = new Set(taken.map((repository) => repository.name.toLowerCase()))
  const base = name.replace(/-(\d+)$/, "")

  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${base}-${suffix}`
    if (!used.has(candidate.toLowerCase())) return candidate
  }
  return `${base}-${Date.now()}`
}
