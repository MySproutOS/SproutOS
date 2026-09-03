import { crudAccount, crudAuditLog, crudOauthIdentityFlow, crudUser, fetchAccount } from "@lib/dao"
import { sealOauthIdentityVerifier } from "@lib/envelope"
import {
  GITHUB_IDENTITY_SCOPES,
  GITHUB_REPOSITORY_SCOPES,
  GOOGLE_SCOPES,
  generateCodeVerifier,
  generateState,
  githubOAuthClient,
  googleOAuthClient,
} from "@lib/oauth"
import { db } from "@sproutos/db"
import { encodeHexLowerCase, sha256Utf8 } from "@utils/crypto"
import { Hono } from "hono"
import { describeRoute } from "hono-typebox-openapi"
import { resolver } from "hono-typebox-openapi/typebox"
import { v7 } from "uuid"
import { authMiddleware } from "../middleware"
import { EmptyObject, ErrorSchemaResponse } from "../utils/common.serializer"
import {
  throwConflict,
  throwForbidden,
  throwNotFound,
  throwUnauthenticated,
} from "../utils/http-exception"
import { auditContext } from "../utils/request-context"
import { validator } from "../utils/validator"
import {
  signInMethodSchemaAuthorizeRequest,
  signInMethodSchemaAuthorizeResponse,
  signInMethodSchemaListResponse,
  signInMethodSchemaParam,
  signInMethodSchemaUnlinkRequest,
} from "./sign-in-methods.serializer"

const RECENT_REAUTHENTICATION_MS = 15 * 60 * 1000
const FLOW_LIFETIME_MS = 10 * 60 * 1000

const errorResponse = {
  content: { "application/json": { schema: resolver(ErrorSchemaResponse) } },
}

export function hasRecentReauthentication(reauthenticatedAt: Date | null, now = new Date()) {
  return (
    reauthenticatedAt !== null &&
    reauthenticatedAt <= now &&
    now.getTime() - reauthenticatedAt.getTime() <= RECENT_REAUTHENTICATION_MS
  )
}

export function safeIdentityReturnPath(value: string): string | null {
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return null
  try {
    const parsed = new URL(value, "https://sproutos.invalid")
    return parsed.origin === "https://sproutos.invalid"
      ? `${parsed.pathname}${parsed.search}${parsed.hash}`
      : null
  } catch {
    return null
  }
}

function requireRecentSession(c: Parameters<typeof throwForbidden>[0]) {
  const session = c.var.session as { reauthenticatedAt: Date | null } | null
  if (session === null) return false
  return hasRecentReauthentication(session.reauthenticatedAt)
}

const app = new Hono()
  .use(authMiddleware)
  .get(
    "/",
    describeRoute({
      description: "Lists the current user's Google and GitHub sign-in methods",
      responses: {
        200: {
          description: "Sign-in methods",
          content: { "application/json": { schema: resolver(signInMethodSchemaListResponse) } },
        },
      },
    }),
    async (c) => {
      const rows = await fetchAccount(db).listSignInMethods(c.var.user.id)
      return c.json({
        data: rows.map((row) => ({
          id: row.id,
          provider: row.provider as "google" | "github",
          displayIdentity: row.displayIdentity ?? `${row.provider} account`,
          connectedAt: row.createdAt.toISOString(),
          repositoryAccessNeedsReauthorization:
            row.provider === "github" && !row.scopes.includes("repo"),
          canUnlink: rows.length > 1,
        })),
      })
    },
  )
  .post(
    "/authorize",
    describeRoute({
      description: "Begins a session-bound sign-in identity link or reauthorization",
      responses: {
        200: {
          description: "Provider authorization URL",
          content: {
            "application/json": { schema: resolver(signInMethodSchemaAuthorizeResponse) },
          },
        },
        401: { description: "A browser session is required", ...errorResponse },
        403: { description: "Recent reauthentication is required", ...errorResponse },
        404: { description: "Sign-in method not found", ...errorResponse },
      },
    }),
    validator("json", signInMethodSchemaAuthorizeRequest),
    async (c) => {
      if (c.var.session === null) return throwUnauthenticated(c, "A browser session is required")
      if (!requireRecentSession(c)) {
        return throwForbidden(c, "Sign in again before changing sign-in methods")
      }
      const input = c.req.valid("json")
      const returnTo = safeIdentityReturnPath(input.returnTo)
      if (returnTo === null) return throwForbidden(c, "Return path is not allowed")

      let target = undefined
      if (input.intent === "reauthorize") {
        if (input.methodId === undefined) return throwNotFound(c, "Sign-in method not found")
        target = await fetchAccount(db).getForUser(c.var.user.id, input.methodId, [
          "id",
          "provider",
        ])
        if (target === undefined || target.provider !== input.provider) {
          return throwNotFound(c, "Sign-in method not found")
        }
      }

      const flowId = v7()
      const state = generateState()
      const verifier = generateCodeVerifier()
      const sealed = await sealOauthIdentityVerifier(flowId, c.var.user.id, verifier)
      const scopes =
        input.provider === "google"
          ? GOOGLE_SCOPES
          : input.intent === "reauthorize"
            ? GITHUB_REPOSITORY_SCOPES
            : GITHUB_IDENTITY_SCOPES
      const authorizationUrl = await (
        input.provider === "google" ? googleOAuthClient() : githubOAuthClient()
      ).createAuthorizationUrl(state, verifier, [...scopes])

      await crudOauthIdentityFlow(db).create({
        id: flowId,
        stateHash: encodeHexLowerCase(await sha256Utf8(state)),
        userId: c.var.user.id,
        sessionKey: c.var.session.sessionKey,
        provider: input.provider,
        intent: input.intent,
        targetAccountId: target?.id ?? null,
        pkceCiphertext: sealed.ciphertext,
        pkceWrappedDek: sealed.wrappedDek,
        pkceKmsKeyId: sealed.kmsKeyId,
        returnTo,
        expiresAt: new Date(Date.now() + FLOW_LIFETIME_MS),
      })
      return c.json({ authorizationUrl: authorizationUrl.toString() })
    },
  )
  .delete(
    "/:methodId",
    describeRoute({
      description: "Unlinks one sign-in method after explicit confirmation",
      responses: {
        200: {
          description: "Method unlinked",
          content: { "application/json": { schema: resolver(EmptyObject) } },
        },
        401: { description: "A browser session is required", ...errorResponse },
        403: { description: "Recent reauthentication is required", ...errorResponse },
        404: { description: "Sign-in method not found", ...errorResponse },
        409: { description: "The method is currently required", ...errorResponse },
      },
    }),
    validator("param", signInMethodSchemaParam),
    validator("json", signInMethodSchemaUnlinkRequest),
    async (c) => {
      if (c.var.session === null) return throwUnauthenticated(c, "A browser session is required")
      if (!requireRecentSession(c)) {
        return throwForbidden(c, "Sign in again before changing sign-in methods")
      }
      const { methodId } = c.req.valid("param")
      const outcome = await db.transaction().execute(async (tx) => {
        const methods = await fetchAccount(tx).lockSignInMethods(c.var.user.id)
        const method = methods.find((candidate) => candidate.id === methodId)
        if (method === undefined) return "not_found" as const
        if (methods.length <= 1) return "last_method" as const
        if (
          method.provider === "github" &&
          (await fetchAccount(tx).hasGithubDependentWork(c.var.user.id))
        ) {
          return "github_required" as const
        }
        if (!(await crudAccount(tx).deleteAccount(methodId, c.var.user.id))) {
          throw new Error("Sign-in method disappeared during unlink")
        }
        if (method.provider === "github") {
          const remaining = await fetchAccount(tx).newestGithubIdentity(c.var.user.id, [
            "providerAccountId",
            "displayIdentity",
          ])
          await crudUser(tx).updateGithubIdentity(
            c.var.user.id,
            remaining === undefined
              ? null
              : {
                  githubLogin: remaining.displayIdentity,
                  githubUserId: BigInt(remaining.providerAccountId),
                },
          )
        }
        await crudAuditLog(tx).record({
          organizationId: null,
          actorUserId: c.var.user.id,
          action: "security:sign-in-method:unlink",
          resourceSrn: `srn:sproutos:iam::account/${methodId}`,
          before: { provider: method.provider, displayIdentity: method.displayIdentity },
          ...auditContext(c),
        })
        return "deleted" as const
      })
      if (outcome === "not_found") return throwNotFound(c, "Sign-in method not found")
      if (outcome === "last_method") {
        return throwConflict(c, "Link another sign-in method before removing this one")
      }
      if (outcome === "github_required") {
        return throwConflict(
          c,
          "GitHub is required by active repository work. Wait for it to finish or install the GitHub App, then retry.",
        )
      }
      return c.json({})
    },
  )

export default app
