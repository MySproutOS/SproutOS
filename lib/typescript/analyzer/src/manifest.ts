/**
 * What an analysis produces: a description of what a repository needs to run here.
 *
 * TASKS 38 and 39 ask for the same artifact from two directions — importing a repository that is
 * not in the store, and proposing one for it — so there is one shape and one analyser rather than
 * two that drift.
 *
 * The manifest is **reviewable**, not executable. `services` feeds provisioning and
 * `modifications` becomes a pull request someone reads; nothing here is applied silently.
 */

export const SERVICE_KINDS = ["postgres", "valkey", "elasticsearch"] as const
export type ManifestServiceKind = (typeof SERVICE_KINDS)[number]

export type ManifestEnvVar = {
  name: string
  /** Whether the value is a credential. Decides masking, not encryption — everything is encrypted. */
  secret: boolean
  /** Whether SproutOS can fill it in, e.g. a database URL from a service we provision. */
  providedByPlatform: boolean
  purpose: string
}

export type ManifestModification = {
  path: string
  reason: string
}

export type RepoManifest = {
  runtime: string
  buildCommand: string | null
  startCommand: string | null
  port: number | null
  services: ManifestServiceKind[]
  envVars: ManifestEnvVar[]
  migrations: string | null
  modifications: ManifestModification[]
  /**
   * What the model could not determine.
   *
   * First-class rather than prose in a summary, because an analyser that cannot say "I don't know"
   * produces a manifest someone trusts and shouldn't. A deploy that fails for a stated unknown is
   * a different conversation from one that fails for a reason nobody mentioned.
   */
  unknowns: string[]
  summary: string
}

export class InvalidManifestError extends Error {
  override readonly name = "InvalidManifestError"

  constructor(readonly problem: string) {
    super(`The analysis did not produce a usable manifest: ${problem}`)
  }
}

/**
 * Validate a model's output before it reaches the database.
 *
 * A model asked for JSON usually returns JSON, and the failure mode when it does not is a manifest
 * with a `services` array full of strings nobody implements, or a port of `"8080"`. Both provision
 * badly rather than loudly, so the shape is checked at the boundary — and unrecognised service
 * kinds are dropped rather than rejected, because a repository needing Kafka should still yield a
 * usable manifest that mentions Kafka in `unknowns`.
 */
export function parseManifest(raw: unknown): { manifest: RepoManifest; confidence: number } {
  if (typeof raw !== "object" || raw === null) throw new InvalidManifestError("not an object")
  const value = raw as Record<string, unknown>

  const runtime = asString(value.runtime)
  if (runtime === null) throw new InvalidManifestError("no runtime")

  const known: ManifestServiceKind[] = []
  const unknowns = asStringArray(value.unknowns)
  for (const service of asStringArray(value.services)) {
    const normalized = service.toLowerCase().trim()
    if ((SERVICE_KINDS as readonly string[]).includes(normalized)) {
      if (!known.includes(normalized as ManifestServiceKind)) {
        known.push(normalized as ManifestServiceKind)
      }
    } else if (normalized !== "") {
      // Kept, not discarded: "this app needs Kafka and we do not offer it" is the single most
      // useful thing an analysis can tell someone about to fork it.
      unknowns.push(`Needs ${service}, which SproutOS does not offer yet`)
    }
  }

  return {
    manifest: {
      runtime,
      buildCommand: asString(value.buildCommand),
      startCommand: asString(value.startCommand),
      port: asPort(value.port),
      services: known,
      envVars: asEnvVars(value.envVars),
      migrations: asString(value.migrations),
      modifications: asModifications(value.modifications),
      unknowns,
      summary: asString(value.summary) ?? "",
    },
    confidence: asConfidence(value.confidence),
  }
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  // Models say "none" and "N/A" when they mean null, and a build command of "none" would be run.
  if (trimmed === "" || /^(none|n\/a|null|unknown)$/i.test(trimmed)) return null
  return trimmed
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string" && item.trim() !== "")
}

/** A port as a number, whether the model sent 8080 or "8080", and only if it is a real port. */
function asPort(value: unknown): number | null {
  const port = typeof value === "string" ? Number(value) : value
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535) return null
  return port
}

function asConfidence(value: unknown): number {
  const confidence = typeof value === "string" ? Number(value) : value
  if (typeof confidence !== "number" || Number.isNaN(confidence)) return 0
  // A model that returns 0.8 meaning "80%" is common enough to handle rather than record as 0.
  const scaled = confidence > 0 && confidence <= 1 ? confidence * 100 : confidence
  return Math.max(0, Math.min(100, Math.round(scaled)))
}

function asEnvVars(value: unknown): ManifestEnvVar[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const vars: ManifestEnvVar[] = []

  for (const item of value) {
    if (typeof item !== "object" || item === null) continue
    const entry = item as Record<string, unknown>
    const name = asString(entry.name)
    // Environment variable names are a narrow set, and one that is not is a hallucinated sentence.
    if (name === null || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || seen.has(name)) continue
    seen.add(name)

    vars.push({
      name,
      secret: entry.secret === true,
      providedByPlatform: entry.providedByPlatform === true,
      purpose: asString(entry.purpose) ?? "",
    })
  }

  return vars
}

function asModifications(value: unknown): ManifestModification[] {
  if (!Array.isArray(value)) return []
  const modifications: ManifestModification[] = []

  for (const item of value) {
    if (typeof item !== "object" || item === null) continue
    const entry = item as Record<string, unknown>
    const path = asString(entry.path)
    const reason = asString(entry.reason)
    if (path === null || reason === null) continue
    // A path that escapes the repository is either a hallucination or an attempt; neither belongs
    // in something a person will act on.
    if (path.startsWith("/") || path.includes("..")) continue
    modifications.push({ path, reason })
  }

  return modifications
}
