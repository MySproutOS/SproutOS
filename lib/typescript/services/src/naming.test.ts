import { readFileSync } from "node:fs"
import { decodeShortId, encodeShortId, tenantUsername } from "./tenant-auth"
import { describe, expect, it } from "vitest"
import { assertSafeIdentifier, databaseNameFor, postgresUri, roleNameFor } from "./naming"

describe("identifiers", () => {
  const id = "01a01e43-3cd3-75a3-8b15-e142b9ba6e73"

  it("derives names from the id, not from anything a customer typed", () => {
    /*
      DDL cannot be parameterized, so the only safe input is one that came from us.

      The *short id*, not the UUID's hex. This assertion used to read
      `sprout_db_01a01e433cd375a38b15e142b9ba6e73` — 32 hex characters — and it was green while
      `lib/rust/tenant-auth`, which the proxies route with, derived
      `sprout_db_01mg1bpkfz79gtb9bh85sbc2v2` from the same id and asserted *that* in its own test.
      Two passing suites, one contract, two answers. See the vectors at the bottom of this file.
    */
    expect(databaseNameFor(id)).toBe(`sprout_db_${encodeShortId(id)}`)
    expect(roleNameFor(id)).toBe(`sprout_r_${encodeShortId(id)}`)
    expect(databaseNameFor(id)).not.toContain(id.replaceAll("-", ""))
  })

  it("stays inside Postgres's 63-byte identifier limit", () => {
    // Past 63 bytes Postgres truncates silently, and two services whose names truncate to the
    // same thing would collide on CREATE ROLE.
    expect(databaseNameFor(id).length).toBeLessThanOrEqual(63)
    expect(roleNameFor(id).length).toBeLessThanOrEqual(63)
  })

  it("accepts what it generates and refuses what it does not", () => {
    assertSafeIdentifier(databaseNameFor(id))
    assertSafeIdentifier(roleNameFor(id))

    expect(() => {
      assertSafeIdentifier('sprout"; drop database postgres --')
    }).toThrow(RangeError)
    expect(() => {
      assertSafeIdentifier("Sprout_Db")
    }).toThrow(RangeError)
    expect(() => {
      assertSafeIdentifier("")
    }).toThrow(RangeError)
    expect(() => {
      assertSafeIdentifier("9starts_with_a_digit")
    }).toThrow(RangeError)
  })
})

describe("postgresUri", () => {
  it("percent-encodes a password that would otherwise change the host", () => {
    // `@` ends the userinfo. Unencoded, this URI points at "evil.example" and a client would
    // happily connect there with the customer's credentials.
    const uri = postgresUri({
      host: "db.sprout.run",
      port: 5432,
      database: "sprout_db_x",
      username: "sprout_r_x",
      password: "p@ss/word#1",
    })

    expect(uri).toBe("postgresql://sprout_r_x:p%40ss%2Fword%231@db.sprout.run:5432/sprout_db_x")
    expect(new URL(uri).hostname).toBe("db.sprout.run")
  })

  it("carries sslmode when asked", () => {
    const uri = postgresUri({
      host: "h",
      port: 5432,
      database: "d",
      username: "u",
      password: "p",
      sslmode: "require",
    })
    expect(uri).toContain("?sslmode=require")
  })
})

/*
  The shared cross-language vectors.

  `lib/rust/tenant-auth` derives the same names to route a tenant's connection, and this side
  creates the database and the role. Before this file existed the two had drifted — TypeScript built
  names from the raw UUID hex and Rust from the Crockford short id — and each language's own test
  asserted its own answer, so both were green while the proxy would have looked for a database that
  did not exist.

  Read from the file rather than copied into it, because a copy is a second place for the contract
  to live.
*/
describe("the cross-language naming vectors", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL("../../../rust/tenant-auth/fixtures/naming-vectors.json", import.meta.url),
      "utf8",
    ),
  ) as {
    cases: {
      organizationId: string
      resourceId: string
      kind: "database" | "queue" | "searchIndex"
      shortId: string
      username: string
      database: string
      role: string
    }[]
  }

  it("has vectors at all — an empty file would make every assertion below vacuous", () => {
    expect(fixture.cases.length).toBeGreaterThan(2)
  })

  it.each(fixture.cases)("$kind $shortId", (vector) => {
    expect(encodeShortId(vector.resourceId)).toBe(vector.shortId)
    expect(databaseNameFor(vector.resourceId)).toBe(vector.database)
    expect(roleNameFor(vector.resourceId)).toBe(vector.role)
    expect(
      tenantUsername({
        organizationId: vector.organizationId,
        kind: vector.kind,
        resourceId: vector.resourceId,
      }),
    ).toBe(vector.username)
  })
})

/*
  The short id has to be reversible, and it has to refuse rather than guess.

  The master queue reports activity as `<resource-short-id>/<queue>` — a short id is what the key
  prefix carries, and the proxy has no reason to hold the UUID as text. The dispatcher has to get
  back to a `backend_service` row, and a decoder that quietly produced a *different valid UUID* for
  a malformed input would start a worker for the wrong tenant with the right-looking id.
*/
describe("decodeShortId", () => {
  const cases = (
    JSON.parse(
      readFileSync(
        new URL("../../../rust/tenant-auth/fixtures/naming-vectors.json", import.meta.url),
        "utf8",
      ),
    ) as {
      cases: {
        organizationId: string
        resourceId: string
        shortId: string
        organizationShortId: string
      }[]
    }
  ).cases

  it("round-trips every vector", () => {
    expect(cases.length).toBeGreaterThan(2)
    for (const vector of cases) {
      expect(decodeShortId(vector.shortId)).toBe(vector.resourceId)
      expect(decodeShortId(vector.organizationShortId)).toBe(vector.organizationId)
    }
  })

  it("round-trips an arbitrary UUID", () => {
    const id = "01912d40-0000-7000-8000-0000000000a1"
    expect(decodeShortId(encodeShortId(id))).toBe(id)
  })

  it("refuses the wrong length", () => {
    expect(() => decodeShortId("01j4pm")).toThrow(RangeError)
    expect(() =>
      decodeShortId(`${encodeShortId("01912d40-0000-7000-8000-0000000000a1")}x`),
    ).toThrow(RangeError)
  })

  /*
    Crockford base32 omits `i`, `l`, `o` and `u` — deliberately, because they are the characters
    people mistranscribe. A character-class check would accept them; the alphabet lookup does not.
  */
  it("refuses a letter the alphabet does not contain", () => {
    const valid = encodeShortId("01912d40-0000-7000-8000-0000000000a1")
    for (const wrong of ["i", "l", "o", "u"]) {
      expect(() => decodeShortId(valid.slice(0, 25) + wrong)).toThrow(RangeError)
    }
  })

  /*
    26 characters carry 130 bits and a UUID is 128. A short id beginning above `7` is one this
    encoder never produced, and truncating it would name a real, wrong tenant.
  */
  it("refuses a value that cannot be a UUID", () => {
    expect(() => decodeShortId("z".repeat(26))).toThrow(RangeError)
    expect(() => decodeShortId(`8${"0".repeat(25)}`)).toThrow(RangeError)
  })
})
