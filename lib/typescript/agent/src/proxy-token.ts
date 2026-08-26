import { crudAgentProxyToken, fetchAgentProxyToken } from "@lib/dao"
import type { DB } from "@sproutos/db"
import { encodeHexLowerCase, generateUrlSafeToken, sha256Utf8 } from "@utils/crypto"
import type { Kysely } from "kysely"
import { v7 } from "uuid"

/**
 * The credential a sandbox agent is given, in place of a model provider's.
 *
 * The rule this implements was already written down in `CreateSandboxInput.env` — "Never the
 * customer's raw LLM credential" — and had nothing behind it. A sandbox exists so a model can run
 * arbitrary commands; a provider key in its environment is one `printenv` from being exfiltrated,
 * bills the customer directly, and cannot be rotated by us.
 *
 * A token minted here is useful only against our own proxy, only for one project, and only until it
 * expires.
 */

/**
 * Fifteen minutes.
 *
 * Short enough that a leaked access token is worth little, long enough that the refresh path is not
 * on the hot path of every model call. The agent refreshes; the window is not the length of a turn.
 */
export const ACCESS_TTL_MS = 15 * 60 * 1000

/**
 * Twelve hours.
 *
 * The outer bound on a single sandbox session. A refresh token is revocable and rotates on every
 * use, so its window is about how long an abandoned sandbox stays able to spend money — not about
 * how long anyone should be able to hold a secret.
 */
export const REFRESH_TTL_MS = 12 * 60 * 60 * 1000

export type MintedProxyToken = {
  id: string
  /** The bearer the agent sends. Returned once and never recoverable — only its hash is stored. */
  accessToken: string
  refreshToken: string
  accessExpiresAt: Date
  refreshExpiresAt: Date
}

/**
 * A token, and the hash that is all we keep.
 *
 * 32 bytes from `randomBytes`, base64url. Not a JWT: a JWT would let the proxy skip a database read
 * by trusting a signature, and that is exactly the property we do not want here — a revoked
 * sandbox must stop working *now*, not when its claim expires. The read is one indexed lookup.
 */
async function issue(prefix: string): Promise<{ token: string; hash: string }> {
  const token = `${prefix}_${generateUrlSafeToken()}`
  return { hash: await hashToken(token), token }
}

/** The stored form. Hex rather than base64 so it is greppable in a log nobody meant to write. */
async function hashToken(token: string): Promise<string> {
  return encodeHexLowerCase(await sha256Utf8(token))
}

export async function mintProxyToken(
  db: Kysely<DB>,
  input: {
    organizationId: string
    projectId: string | null
    /** Absent means the platform's own key, billed to credit. */
    agentCredentialId: string | null
    now?: Date
  },
): Promise<MintedProxyToken> {
  const now = input.now ?? new Date()
  const access = await issue("spa")
  const refresh = await issue("spr")

  const accessExpiresAt = new Date(now.getTime() + ACCESS_TTL_MS)
  const refreshExpiresAt = new Date(now.getTime() + REFRESH_TTL_MS)

  const { id } = await crudAgentProxyToken(db).create({
    accessExpiresAt,
    accessTokenHash: access.hash,
    agentCredentialId: input.agentCredentialId,
    id: v7(),
    organizationId: input.organizationId,
    projectId: input.projectId,
    refreshExpiresAt,
    refreshTokenHash: refresh.hash,
  })

  return {
    accessExpiresAt,
    accessToken: access.token,
    id,
    refreshExpiresAt,
    refreshToken: refresh.token,
  }
}

export class RefreshRejectedError extends Error {
  override readonly name = "RefreshRejectedError"

  constructor(readonly reason: "unknown" | "expired" | "revoked") {
    super(`the refresh token was rejected: ${reason}`)
  }
}

/**
 * Exchange a refresh token for a new pair.
 *
 * **Both halves rotate.** Issuing a new access token while leaving the refresh token alone would
 * mean a leaked refresh token stays useful for its entire window regardless of how often the
 * legitimate holder refreshes — which is the one thing refresh rotation is for.
 *
 * The reason is not distinguished in what the caller returns to the network: "unknown", "expired"
 * and "revoked" are one 401 to whoever is holding the token, because telling an attacker which of
 * those it was is telling them whether the token was ever real.
 */
export async function refreshProxyToken(
  db: Kysely<DB>,
  refreshToken: string,
  now: Date = new Date(),
): Promise<MintedProxyToken> {
  const found = await fetchAgentProxyToken(db).liveByRefreshHash(await hashToken(refreshToken))
  if (found === undefined) throw new RefreshRejectedError("unknown")

  const access = await issue("spa")
  const refresh = await issue("spr")
  const accessExpiresAt = new Date(now.getTime() + ACCESS_TTL_MS)
  /*
    The refresh window is extended, not reset from the original mint.

    An agent that keeps working keeps its session; one that stops loses it. Capping the total
    session instead would end a turn mid-sentence at a wall-clock boundary the customer cannot see.
  */
  const refreshExpiresAt = new Date(now.getTime() + REFRESH_TTL_MS)

  await crudAgentProxyToken(db).rotate(found.id, {
    accessExpiresAt,
    accessTokenHash: access.hash,
    refreshExpiresAt,
    refreshTokenHash: refresh.hash,
  })

  return {
    accessExpiresAt,
    accessToken: access.token,
    id: found.id,
    refreshExpiresAt,
    refreshToken: refresh.token,
  }
}
