import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  containsWildcard,
  expandSrnTarget,
  formatSrn,
  organizationScopeSrn,
  organizationUuid,
  parseSrn,
  parseSrnPattern,
  srnFor,
  SrnParseError,
  srnMatches,
  srnPatternMatches,
  tryParseSrn,
} from "./index"

/**
 * The cross-language contract. This is the *same file* the Rust crate's tests read; it is not a
 * copy. A divergence between the two implementations is a security bug, because `pg-proxy` and
 * `valkey-proxy` authorize against the Rust side and the API against this one.
 */
const fixturePath = join(
  dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))),
  "rust",
  "srn",
  "fixtures",
  "srn-cases.json",
)

type FixtureCase = {
  pattern: string
  target: string
  matches: boolean
  note: string
}

type Fixture = {
  cases: FixtureCase[]
  invalid: string[]
}

const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture

describe("the fixture file", () => {
  it("is the substantial contract the Rust crate also asserts against", () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(40)
    expect(fixture.invalid.length).toBeGreaterThan(0)
  })
})

describe("fixture matching cases", () => {
  it.each(fixture.cases)("$pattern vs $target — $note", (testCase) => {
    const pattern = parseSrnPattern(testCase.pattern)
    const target = parseSrn(testCase.target)
    expect(srnPatternMatches(pattern, target)).toBe(testCase.matches)
    expect(srnMatches(testCase.pattern, testCase.target)).toBe(testCase.matches)
  })
})

describe("fixture round-tripping", () => {
  it.each(fixture.cases.flatMap((testCase) => [testCase.pattern, testCase.target]))(
    "%s formats back to itself byte for byte",
    (raw) => {
      const parsed = parseSrn(raw)
      expect(formatSrn(parsed)).toBe(raw)
      expect(parseSrn(formatSrn(parsed))).toStrictEqual(parsed)
    },
  )
})

describe("fixture rejections", () => {
  it.each(fixture.invalid)("rejects %j as both a name and a pattern", (raw) => {
    expect(() => parseSrn(raw)).toThrow(SrnParseError)
    expect(() => parseSrnPattern(raw)).toThrow(SrnParseError)
    expect(tryParseSrn(raw)).toBeNull()
  })
})

/**
 * The permission query cannot ask Postgres to run [[srnPatternMatches]] against a `text[]` of
 * stored grants, so it expands the *target* into every pattern that could cover it and tests
 * array overlap. That rewrite is only sound if the two agree on every case in the contract.
 */
describe("target expansion is equivalent to pattern matching", () => {
  it.each(fixture.cases)("$pattern vs $target — $note", (testCase) => {
    const expanded = expandSrnTarget(parseSrn(testCase.target))
    expect(expanded.includes(testCase.pattern)).toBe(testCase.matches)
  })

  it("stays within a small constant number of strings", () => {
    for (const testCase of fixture.cases) {
      expect(expandSrnTarget(parseSrn(testCase.target)).length).toBeLessThanOrEqual(20)
    }
  })

  it("covers a target under the organization-wide grant the system roles seed", () => {
    const organizationId = "01912d3f-8a2b-7c4d-9e1f-2a3b4c5d6e7f"
    const target = srnFor("workflow", organizationId, "run", "01912d43-0000-7000-8000-0000000000d1")
    expect(expandSrnTarget(parseSrn(target))).toContain(organizationScopeSrn(organizationId))
  })

  it("does not cover a target in another organization", () => {
    const target = srnFor("workflow", "0191a0b1-c2d3-7e4f-8a9b-0c1d2e3f4a5b", "run", "abc")
    expect(expandSrnTarget(parseSrn(target))).not.toContain(
      organizationScopeSrn("01912d3f-8a2b-7c4d-9e1f-2a3b4c5d6e7f"),
    )
  })
})

describe("helpers", () => {
  it("reports wildcards", () => {
    expect(containsWildcard(parseSrn("srn:sproutos:db:*:database/main"))).toBe(true)
    expect(containsWildcard(parseSrn("srn:sproutos:db:01912d3f-8a2b:database/main"))).toBe(false)
  })

  it("reads the organization segment as a UUID only when it is one", () => {
    const organizationId = "01912d3f-8a2b-7c4d-9e1f-2a3b4c5d6e7f"
    expect(organizationUuid(parseSrn(srnFor("db", organizationId, "database", "main")))).toBe(
      organizationId,
    )
    expect(organizationUuid(parseSrn("srn:sproutos:db:*:database/main"))).toBeNull()
    expect(organizationUuid(parseSrn("srn:sproutos:db:acme:database/main"))).toBeNull()
  })

  it("builds SRNs whose organization segment is the one it was given", () => {
    const organizationId = "01912d3f-8a2b-7c4d-9e1f-2a3b4c5d6e7f"
    expect(srnFor("org", organizationId, "member", "01912d41-0000-7000-8000-0000000000b1")).toBe(
      `srn:sproutos:org:${organizationId}:member/01912d41-0000-7000-8000-0000000000b1`,
    )
  })

  it("lowercases ids so a client-supplied uppercase UUID parses instead of failing closed", () => {
    const built = srnFor("org", "01912D3F-8A2B-7C4D-9E1F-2A3B4C5D6E7F", "role", "01912D41-0000")
    expect(() => parseSrn(built)).not.toThrow()
  })

  it("never matches unparsable strings", () => {
    expect(srnMatches("nonsense", "srn:sproutos:db:*:database/main")).toBe(false)
    expect(srnMatches("srn:sproutos:db:*:database/*", "nonsense")).toBe(false)
  })
})
