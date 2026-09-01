import type { DB } from "@sproutos/db"
import type { Kysely } from "kysely"
import { describe, expect, it, vi } from "vitest"
import { NoUsableCredentialError, snapshotWriteCredential } from "./provision"

const db = {} as Kysely<DB>
type Resolvers = NonNullable<Parameters<typeof snapshotWriteCredential>[2]>
const base = {
  organizationId: "01900000-0000-7000-8000-000000000001",
  userId: "01900000-0000-7000-8000-000000000002",
  ownerLogin: "TestSproutOS",
  repositoryId: 424242,
}

describe("snapshot repository write credentials", () => {
  it("keeps a user credential that created a personal repository", async () => {
    const user = { kind: "user", token: "gho_creator" } as const
    const installation = vi.fn<Resolvers["installation"]>()
    const fallback = vi.fn<Resolvers["user"]>()

    await expect(
      snapshotWriteCredential(
        db,
        { ...base, provisionCredential: user },
        { installation, user: fallback },
      ),
    ).resolves.toBe(user)
    expect(installation).not.toHaveBeenCalled()
    expect(fallback).not.toHaveBeenCalled()
  })

  it("uses an exact installation token when the new repository is selected", async () => {
    const provision = {
      kind: "installation",
      token: "ghs_provision",
      installationId: 7,
      expiresAt: new Date("2030-01-01T00:00:00Z"),
    } as const
    const exact = { ...provision, token: "ghs_exact" }
    const installation = vi.fn<Resolvers["installation"]>().mockResolvedValue(exact)
    const fallback = vi.fn<Resolvers["user"]>()

    await expect(
      snapshotWriteCredential(
        db,
        { ...base, provisionCredential: provision },
        { installation, user: fallback },
      ),
    ).resolves.toBe(exact)
    expect(installation).toHaveBeenCalledWith(
      db,
      base.organizationId,
      { purpose: "repository-snapshot-push", repositoryId: base.repositoryId },
      base.ownerLogin,
    )
    expect(fallback).not.toHaveBeenCalled()
  })

  it("falls back to the initiating user when a selected-repository installation excludes it", async () => {
    const provision = {
      kind: "installation",
      token: "ghs_provision",
      installationId: 7,
      expiresAt: new Date("2030-01-01T00:00:00Z"),
    } as const
    const user = { kind: "user", token: "gho_creator" } as const
    const installation = vi.fn<Resolvers["installation"]>().mockResolvedValue(undefined)
    const fallback = vi.fn<Resolvers["user"]>().mockResolvedValue(user)

    await expect(
      snapshotWriteCredential(
        db,
        { ...base, provisionCredential: provision },
        { installation, user: fallback },
      ),
    ).resolves.toBe(user)
    expect(fallback).toHaveBeenCalledWith(db, base.userId)
  })

  it("fails clearly when neither credential can write the new repository", async () => {
    const provision = {
      kind: "installation",
      token: "ghs_provision",
      installationId: 7,
      expiresAt: new Date("2030-01-01T00:00:00Z"),
    } as const

    await expect(
      snapshotWriteCredential(
        db,
        { ...base, provisionCredential: provision },
        {
          installation: vi.fn<Resolvers["installation"]>().mockResolvedValue(undefined),
          user: vi.fn<Resolvers["user"]>().mockResolvedValue(undefined),
        },
      ),
    ).rejects.toBeInstanceOf(NoUsableCredentialError)
  })
})
