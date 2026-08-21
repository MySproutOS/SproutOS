import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
  ACCESS_KEY_PREFIX,
  SECRET_BYTES,
  SHORT_ID_LEN,
  decodeShortId,
  deriveObjectStorageSecret,
  encodeShortId,
  generateSecret,
  hashGeneratedSecret,
  lastFour,
  objectStorageAccessKeyId,
  tenantIndexPrefix,
  tenantUsername,
} from "./tenant-auth"

/*
  These fixtures are duplicated, character for character, in `lib/rust/tenant-auth/src/lib.rs`.

  That is the point: the control plane writes these values and a Rust proxy reads them, with no
  shared code between them. A change on one side that is not made on the other must turn a test red
  here *and* there, rather than being discovered when a tenant cannot connect — or when one
  connects to somebody else's keyspace.
*/
const ORG = "01912d3f-8a2b-7c4d-9e1f-2a3b4c5d6e7f"
const RESOURCE = "01912d40-0000-7000-8000-0000000000a1"

describe("encodeShortId", () => {
  it("matches the Rust encoder on the shared fixtures", () => {
    expect(encodeShortId("00000000-0000-0000-0000-000000000000")).toBe("0".repeat(SHORT_ID_LEN))
    expect(encodeShortId("ffffffff-ffff-ffff-ffff-ffffffffffff")).toBe("7zzzzzzzzzzzzzzzzzzzzzzzzz")
    expect(encodeShortId("00000000-0000-0000-0000-00000000001f")).toBe("0000000000000000000000000z")
    expect(encodeShortId(ORG)).toBe("01j4pkz2hbfh6sw7sa7d65tvkz")
  })

  it("is always 26 characters of the canonical alphabet", () => {
    const encoded = encodeShortId(RESOURCE)
    expect(encoded).toHaveLength(SHORT_ID_LEN)
    expect(encoded).toMatch(/^[0-7][0-9abcdefghjkmnpqrstvwxyz]{25}$/)
  })

  it("refuses anything that is not a UUID", () => {
    // A malformed id must not encode to *something*: the something would be a valid-looking
    // username pointing at a tenant that does not exist, or one that does.
    expect(() => encodeShortId("not-a-uuid")).toThrow(RangeError)
    expect(() => encodeShortId("")).toThrow(RangeError)
    expect(() => encodeShortId(`${ORG}00`)).toThrow(RangeError)
  })

  it("accepts a UUID however it is cased or dashed", () => {
    expect(encodeShortId(ORG.toUpperCase())).toBe(encodeShortId(ORG))
    expect(encodeShortId(ORG.replaceAll("-", ""))).toBe(encodeShortId(ORG))
  })
})

describe("tenantUsername", () => {
  it("matches the Rust formatter", () => {
    expect(tenantUsername({ organizationId: ORG, kind: "database", resourceId: RESOURCE })).toBe(
      `db_${encodeShortId(RESOURCE)}.${encodeShortId(ORG)}`,
    )
  })

  it("is 56 bytes, inside the Postgres role-name limit", () => {
    for (const kind of ["database", "queue", "searchIndex"] as const) {
      const username = tenantUsername({ organizationId: ORG, kind, resourceId: RESOURCE })
      expect(username).toHaveLength(56)
      expect(username.length).toBeLessThanOrEqual(63)
      expect(username).toMatch(/^[a-z0-9._]+$/)
    }
  })

  it("gives each kind its own prefix", () => {
    const of = (kind: "database" | "queue" | "searchIndex") =>
      tenantUsername({ organizationId: ORG, kind, resourceId: RESOURCE })
    expect(of("database").startsWith("db_")).toBe(true)
    expect(of("queue").startsWith("kv_")).toBe(true)
    expect(of("searchIndex").startsWith("ix_")).toBe(true)
    expect(new Set([of("database"), of("queue"), of("searchIndex")]).size).toBe(3)
  })

  it("distinguishes two resources of the same organization", () => {
    const a = tenantUsername({ organizationId: ORG, kind: "queue", resourceId: RESOURCE })
    const b = tenantUsername({
      organizationId: ORG,
      kind: "queue",
      resourceId: "01912d40-0000-7000-8000-0000000000a2",
    })
    expect(a).not.toBe(b)
  })
})

describe("generateSecret", () => {
  it("is 52 characters over the wire-safe alphabet", () => {
    const secret = generateSecret()
    expect(secret).toHaveLength(Math.ceil((SECRET_BYTES * 8) / 5))
    // No `i`, `l`, `o`, `u`, and nothing that means anything in a URI or a shell — the secret goes
    // into a connection string unquoted.
    expect(secret).toMatch(/^[0-9abcdefghjkmnpqrstvwxyz]{52}$/)
  })

  it("does not repeat", () => {
    const seen = new Set(Array.from({ length: 256 }, () => generateSecret()))
    expect(seen.size).toBe(256)
  })
})

describe("hashGeneratedSecret", () => {
  it("matches the Rust hasher on the shared fixtures", async () => {
    // If these two values ever disagree with `lib/rust/tenant-auth`, every credential already
    // issued stops verifying at the proxy.
    expect(await hashGeneratedSecret("abc")).toBe(
      "sha256$ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    )
    expect(await hashGeneratedSecret("")).toBe(
      "sha256$e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    )
  })

  it("is a prefixed 64-character digest", async () => {
    expect(await hashGeneratedSecret(generateSecret())).toMatch(/^sha256\$[0-9a-f]{64}$/)
  })

  it("does not carry the secret", async () => {
    const secret = generateSecret()
    expect(await hashGeneratedSecret(secret)).not.toContain(secret)
  })
})

describe("lastFour", () => {
  it("shows four characters and no more", () => {
    const secret = generateSecret()
    expect(lastFour(secret)).toHaveLength(4)
    expect(secret.endsWith(lastFour(secret))).toBe(true)
  })
})

describe("tenantIndexPrefix", () => {
  it("matches the prefix the search proxy applies", () => {
    // Duplicated in `services/search-proxy/src/naming.rs`. A divergence here means the reaper
    // deletes either nothing or another tenant's indices, so both sides pin the literal.
    expect(tenantIndexPrefix(RESOURCE)).toBe("t01j4pm0000e008000000000051_")
  })

  it("starts with a letter and ends with the separator", () => {
    const prefix = tenantIndexPrefix(RESOURCE)
    expect(prefix.startsWith("t")).toBe(true)
    expect(prefix.endsWith("_")).toBe(true)
    // An index name is lowercased by OpenSearch on creation, so a prefix that was not already
    // lowercase would not match the index it named.
    expect(prefix).toBe(prefix.toLowerCase())
  })

  it("gives two services two namespaces", () => {
    expect(tenantIndexPrefix(RESOURCE)).not.toBe(tenantIndexPrefix(ORG))
  })
})

describe("object storage credentials", () => {
  /*
    The storage proxy verifies a tenant's SigV4 signature, which means recomputing an HMAC, which
    means holding the tenant's secret. Deriving it from one root key is what keeps `service_credential`
    free of anything reversible — see `deriveObjectStorageSecret`.
  */
  const fixture = JSON.parse(
    readFileSync(
      new URL("../../../rust/s3-sigv4/fixtures/tenant-secret.json", import.meta.url),
      "utf8",
    ),
  ) as {
    cases: {
      rootKey: string
      shortId: string
      version: number
      accessKeyId: string
      secret: string
    }[]
  }

  it("matches the vectors the Rust crate asserts against", async () => {
    // Read from the crate rather than copied here. A divergence is a tenant who cannot authenticate
    // at all — loud, but only if the two sides are actually reading the same bytes.
    for (const testCase of fixture.cases) {
      const id = objectStorageAccessKeyId(decodeShortId(testCase.shortId), testCase.version)

      expect(id).toBe(testCase.accessKeyId)
      expect(await deriveObjectStorageSecret(testCase.rootKey, id)).toBe(testCase.secret)
    }
  })

  it("gives a rotated credential a new secret and the same tenant", async () => {
    const service = "01912d3f-8a2b-7c4d-9e1f-2a3b4c5d6e7f"
    const first = objectStorageAccessKeyId(service, 1)
    const second = objectStorageAccessKeyId(service, 2)

    expect(await deriveObjectStorageSecret("root", first)).not.toBe(
      await deriveObjectStorageSecret("root", second),
    )
    // The proxy resolves a request to a tenant by decoding the id, so rotation must not move it.
    expect(decodeShortId(second.slice(ACCESS_KEY_PREFIX.length, -2).toLowerCase())).toBe(service)
  })

  it("carries nothing that means something in a URI, a shell or a YAML file", async () => {
    // It is pasted into Obsidian's settings by hand, off a screen.
    const secret = await deriveObjectStorageSecret(
      "root",
      objectStorageAccessKeyId("01912d3f-8a2b-7c4d-9e1f-2a3b4c5d6e7f", 1),
    )

    expect(secret).toMatch(/^[0-9a-hjkmnp-tv-z]{52}$/)
  })
})
