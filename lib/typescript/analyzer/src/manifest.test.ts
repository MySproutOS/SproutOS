import { describe, expect, it } from "vitest"
import { InvalidManifestError, parseManifest } from "./manifest"

/**
 * The input here is model output, so every test is a real thing a model does rather than a
 * hypothetical. The failure mode that matters is not a crash — it is a manifest that looks fine
 * and provisions the wrong thing.
 */
const valid = {
  runtime: "node 22",
  buildCommand: "pnpm build",
  startCommand: "pnpm start",
  port: 3000,
  services: ["postgres"],
  envVars: [{ name: "DATABASE_URL", secret: true, providedByPlatform: true, purpose: "Postgres" }],
  migrations: "pnpm migrate",
  modifications: [{ path: "Dockerfile", reason: "Bind to $PORT" }],
  unknowns: [],
  summary: "A Next.js app.",
  confidence: 85,
}

describe("parseManifest", () => {
  it("accepts a well-formed manifest", () => {
    const { manifest, confidence } = parseManifest(valid)
    expect(manifest.runtime).toBe("node 22")
    expect(manifest.services).toEqual(["postgres"])
    expect(confidence).toBe(85)
  })

  it("refuses output that is not a manifest at all", () => {
    expect(() => parseManifest(null)).toThrow(InvalidManifestError)
    expect(() => parseManifest("I could not read the repository")).toThrow(InvalidManifestError)
    expect(() => parseManifest({ ...valid, runtime: "" })).toThrow(InvalidManifestError)
  })

  it('reads "none" as nothing, because a build command of "none" would be run', () => {
    const { manifest } = parseManifest({
      ...valid,
      buildCommand: "none",
      startCommand: "N/A",
      migrations: "unknown",
    })
    expect(manifest.buildCommand).toBeNull()
    expect(manifest.startCommand).toBeNull()
    expect(manifest.migrations).toBeNull()
  })

  it("keeps a service we do not offer, as an unknown rather than a silent omission", () => {
    // The single most useful thing an analysis can tell someone about to fork an app.
    const { manifest } = parseManifest({ ...valid, services: ["postgres", "kafka", "MongoDB"] })
    expect(manifest.services).toEqual(["postgres"])
    expect(manifest.unknowns).toEqual([
      "Needs kafka, which SproutOS does not offer yet",
      "Needs MongoDB, which SproutOS does not offer yet",
    ])
  })

  it("normalizes and de-duplicates service kinds", () => {
    const { manifest } = parseManifest({ ...valid, services: ["Postgres", "postgres", " VALKEY "] })
    expect(manifest.services).toEqual(["postgres", "valkey"])
  })

  it("takes a port whether it is a number or a string, and only if it is one", () => {
    expect(parseManifest({ ...valid, port: "8080" }).manifest.port).toBe(8080)
    expect(parseManifest({ ...valid, port: 0 }).manifest.port).toBeNull()
    expect(parseManifest({ ...valid, port: 70_000 }).manifest.port).toBeNull()
    expect(parseManifest({ ...valid, port: "the default" }).manifest.port).toBeNull()
  })

  it("reads a fractional confidence as a percentage", () => {
    // A model returning 0.8 means 80%, not 0 — and recording 0 would make a good analysis look
    // like one nobody should trust.
    expect(parseManifest({ ...valid, confidence: 0.8 }).confidence).toBe(80)
    expect(parseManifest({ ...valid, confidence: 1 }).confidence).toBe(100)
    expect(parseManifest({ ...valid, confidence: 150 }).confidence).toBe(100)
    expect(parseManifest({ ...valid, confidence: "not sure" }).confidence).toBe(0)
  })

  it("drops env var names that are not env var names", () => {
    const { manifest } = parseManifest({
      ...valid,
      envVars: [
        { name: "DATABASE_URL", secret: true, providedByPlatform: true, purpose: "db" },
        { name: "You will also need an API key", secret: false, purpose: "" },
        { name: "DATABASE_URL", secret: false, purpose: "duplicate" },
      ],
    })
    // A sentence is a hallucination, and the duplicate would overwrite the real entry's flags.
    expect(manifest.envVars.map((entry) => entry.name)).toEqual(["DATABASE_URL"])
    expect(manifest.envVars[0]?.secret).toBe(true)
  })

  it("refuses a modification pointing outside the repository", () => {
    const { manifest } = parseManifest({
      ...valid,
      modifications: [
        { path: "Dockerfile", reason: "fine" },
        { path: "../../etc/passwd", reason: "not fine" },
        { path: "/etc/hosts", reason: "also not fine" },
      ],
    })
    expect(manifest.modifications.map((entry) => entry.path)).toEqual(["Dockerfile"])
  })

  it("survives every optional field being absent", () => {
    // Partial output is the common failure, and it should degrade to a thin manifest rather than
    // an exception that loses the run the customer paid for.
    const { manifest, confidence } = parseManifest({ runtime: "python 3.13" })
    expect(manifest.runtime).toBe("python 3.13")
    expect(manifest.services).toEqual([])
    expect(manifest.envVars).toEqual([])
    expect(manifest.unknowns).toEqual([])
    expect(confidence).toBe(0)
  })
})
