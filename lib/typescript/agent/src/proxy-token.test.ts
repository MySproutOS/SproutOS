import { describe, expect, it } from "vitest"

import {
  ACCESS_TTL_MS,
  mintProxyToken,
  refreshProxyToken,
  RefreshRejectedError,
  REFRESH_TTL_MS,
} from "./proxy-token"

/**
 * A fake database that records what was written, so the tests can assert the properties that
 * matter — what is stored, and what is not.
 */
function fakeDb() {
  const rows: Record<string, Record<string, unknown>> = {}
  const done = () => Promise.resolve()
  const db = {
    insertInto: () => ({
      values: (input: Record<string, unknown>) => ({
        returning: () => ({
          executeTakeFirstOrThrow: () => {
            rows[input.id as string] = { ...input }
            return Promise.resolve({ id: input.id })
          },
        }),
      }),
    }),
    selectFrom: () => {
      let match: Record<string, unknown> | undefined
      const q = {
        executeTakeFirst: () => Promise.resolve(match),
        selectAll: () => q,
        where: (column: string, _op: string, value: unknown) => {
          if (column === "refreshTokenHash") {
            match = Object.values(rows).find((row) => row.refreshTokenHash === value)
          }
          return q
        },
      }
      return q
    },
    updateTable: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => ({
          where: () => ({ execute: done }),
          execute: () => {
            for (const id of Object.keys(rows)) Object.assign(rows[id] as object, patch)
            return done()
          },
        }),
      }),
    }),
  }
  return { db: db as never, rows }
}

describe("mintProxyToken", () => {
  it("stores hashes and never the tokens", async () => {
    const { db, rows } = fakeDb()
    const minted = await mintProxyToken(db, {
      agentCredentialId: null,
      organizationId: "org",
      projectId: "proj",
    })

    const stored = JSON.stringify(rows[minted.id])
    // The property the whole design rests on: a leak of this table yields nothing replayable.
    expect(stored).not.toContain(minted.accessToken)
    expect(stored).not.toContain(minted.refreshToken)
    expect(rows[minted.id]?.accessTokenHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it("gives the two tokens different values and different lifetimes", async () => {
    const { db } = fakeDb()
    const now = new Date("2026-01-01T00:00:00Z")
    const minted = await mintProxyToken(db, {
      agentCredentialId: null,
      now,
      organizationId: "org",
      projectId: null,
    })

    expect(minted.accessToken).not.toBe(minted.refreshToken)
    expect(minted.accessExpiresAt.getTime()).toBe(now.getTime() + ACCESS_TTL_MS)
    expect(minted.refreshExpiresAt.getTime()).toBe(now.getTime() + REFRESH_TTL_MS)
    // The access token must be the shorter one, or the refresh path buys nothing.
    expect(ACCESS_TTL_MS).toBeLessThan(REFRESH_TTL_MS)
  })

  it("does not repeat a token", async () => {
    const { db } = fakeDb()
    const minted = await Promise.all(
      Array.from({ length: 50 }, () =>
        mintProxyToken(db, {
          agentCredentialId: null,
          organizationId: "org",
          projectId: null,
        }),
      ),
    )
    expect(new Set(minted.map((token) => token.accessToken)).size).toBe(50)
  })
})

describe("refreshProxyToken", () => {
  it("rotates both halves, so a leaked refresh token stops working", async () => {
    const { db } = fakeDb()
    const first = await mintProxyToken(db, {
      agentCredentialId: null,
      organizationId: "org",
      projectId: null,
    })

    const second = await refreshProxyToken(db, first.refreshToken)
    expect(second.accessToken).not.toBe(first.accessToken)
    expect(second.refreshToken).not.toBe(first.refreshToken)

    // The old one is gone. Without this a stolen refresh token stays useful for its whole window
    // however many times the real holder refreshes.
    await expect(refreshProxyToken(db, first.refreshToken)).rejects.toBeInstanceOf(
      RefreshRejectedError,
    )
  })

  it("rejects a token it has never seen", async () => {
    const { db } = fakeDb()
    await expect(refreshProxyToken(db, "spr_nothing")).rejects.toBeInstanceOf(RefreshRejectedError)
  })
})

describe("the lifetimes", () => {
  it("are short enough to matter", () => {
    // Stated as a test rather than a comment: these are the blast radius of a leak, and a future
    // change that quietly makes the access token last a day should have to argue with something.
    expect(ACCESS_TTL_MS).toBeLessThanOrEqual(30 * 60 * 1000)
    expect(REFRESH_TTL_MS).toBeLessThanOrEqual(24 * 60 * 60 * 1000)
  })
})
