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
 * Thirty-five minutes.
 *
 * A sandbox turn is bounded at thirty minutes. Claude Code and Codex are stock processes: neither
 * calls SproutOS's refresh endpoint between its own upstream requests, so a fifteen-minute token
 * made a legitimate long turn fail halfway through. Five minutes of margin covers startup and the
 * final push without making the access token a session credential.
 */
export const ACCESS_TTL_MS = 35 * 60 * 1000

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
    /** The person whose live RBAC is re-evaluated for any agent control-plane action. */
    actorUserId?: string | null
    /** Present only when this token was minted inside an actual chat turn. */
    agentSessionId?: string | null
    agentTurnId?: string | null
    /** Absent means the platform's own key, billed to credit. */
    agentCredentialId: string | null
    /*
      What the proxy should send upstream, decided here and carried on the row.

      Resolved once at mint time rather than per request: the router would otherwise re-derive
      configuration that can change under it, and a turn that silently switched providers halfway
      through would be very hard to explain. All three null means the platform's own key, which the
      router reads from its own environment.
    */
    upstreamKind?: string | null
    upstreamBaseUrl?: string | null
    upstreamSecret?: string | null
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
    actorUserId: input.actorUserId ?? null,
    agentSessionId: input.agentSessionId ?? null,
    agentTurnId: input.agentTurnId ?? null,
    id: v7(),
    organizationId: input.organizationId,
    projectId: input.projectId,
    refreshExpiresAt,
    refreshTokenHash: refresh.hash,
    upstreamBaseUrl: input.upstreamBaseUrl ?? null,
    upstreamKind: input.upstreamKind ?? null,
    upstreamSecret: input.upstreamSecret ?? null,
  })

  return {
    accessExpiresAt,
    accessToken: access.token,
    id,
    refreshExpiresAt,
    refreshToken: refresh.token,
  }
}

/** Resolve the short-lived access half without ever storing or logging the bearer itself. */
export async function resolveProxyAccessToken(db: Kysely<DB>, token: string) {
  if (!token.startsWith("spa_")) return undefined
  return await fetchAgentProxyToken(db).liveByAccessHash(await hashToken(token))
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
