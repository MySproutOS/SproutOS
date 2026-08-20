import { describe, expect, it } from "vitest"
import { assertSafeIdentifier, databaseNameFor, postgresUri, roleNameFor } from "./naming"

describe("identifiers", () => {
  const id = "01a01e43-3cd3-75a3-8b15-e142b9ba6e73"

  it("derives names from the id, not from anything a customer typed", () => {
    // DDL cannot be parameterized, so the only safe input is one that came from us.
    expect(databaseNameFor(id)).toBe("sprout_db_01a01e433cd375a38b15e142b9ba6e73")
    expect(roleNameFor(id)).toBe("sprout_r_01a01e433cd375a38b15e142b9ba6e73")
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
