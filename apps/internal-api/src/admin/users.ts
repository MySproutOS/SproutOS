import { crudAuditLog, impersonation } from "@lib/dao"
import { db } from "@sproutos/db"
import { encodeHexLowerCase, generateSessionToken, sha256Utf8 } from "@utils/crypto"
import { Hono } from "hono"
import { getCookie, setCookie } from "hono/cookie"
import { describeRoute } from "hono-typebox-openapi"
import { resolver, validator } from "hono-typebox-openapi/typebox"
import { adminAuthMiddleware } from "./middleware"
import { IMPERSONATOR_COOKIE } from "./impersonator-cookie"
import { cookieDomain } from "../utils/env"
import { ErrorSchemaResponse } from "../utils/common.serializer"
import { throwBadRequest, throwNotFound } from "../utils/http-exception"
import { auditContext } from "../utils/request-context"
import {
  adminSchemaImpersonateRequest,
  adminSchemaImpersonateResponse,
  adminSchemaUserListQuery,
  adminSchemaUserListResponse,
} from "./admin.serializer"

const errorResponse = {
  content: { "application/json": { schema: resolver(ErrorSchemaResponse) } },
}

const DEFAULT_LIMIT = 25

const app = new Hono()
  .use(adminAuthMiddleware)
  .get(
    "/",
    describeRoute({
      description: "Find a user across every organization",
      responses: {
        200: {
          description: "Users",
          content: { "application/json": { schema: resolver(adminSchemaUserListResponse) } },
        },
      },
    }),
    validator("query", adminSchemaUserListQuery),
    async (c) => {
      const { q, limit = DEFAULT_LIMIT, cursor } = c.req.valid("query")

      let query = db
        .selectFrom("user")
        .select((eb) => [
          "user.id",
          "user.email",
          "user.name",
          "user.githubLogin",
          "user.isAdmin",
          "user.deletedAt",
          "user.createdAt",
          eb
            .selectFrom("organizationMember")
            .whereRef("organizationMember.userId", "=", "user.id")
            .select((inner) => inner.fn.countAll<string>().as("count"))
            .as("organizationCount"),
        ])
        // Ascending on a UUIDv7 is ascending on creation time, which is what makes the id usable
        // as the cursor: one column, already indexed, already unique, no tie-break needed.
        .orderBy("user.id", "asc")
        .limit(limit + 1)

      if (cursor !== undefined) query = query.where("user.id", ">", cursor)

      if (q !== undefined && q.trim() !== "") {
        /*
          `ilike` with the term escaped, not interpolated.

          `%` and `_` are wildcards; a support engineer pasting an email that contains one would
          otherwise get a scan that matched far more than they asked for. Escaping them makes the
          search mean what it looks like it means.
        */
        const term = `%${q.trim().replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`
        query = query.where((eb) =>
          eb.or([eb("user.email", "ilike", term), eb("user.githubLogin", "ilike", term)]),
        )
      }

      const rows = await query.execute()
      const page = rows.slice(0, limit)

      return c.json({
        items: page.map((row) => ({
          id: row.id,
          email: row.email,
          name: row.name,
          githubLogin: row.githubLogin,
          isAdmin: row.isAdmin,
          deletedAt: row.deletedAt?.toISOString() ?? null,
          organizationCount: Number(row.organizationCount ?? "0"),
          createdAt: row.createdAt.toISOString(),
        })),
        nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
      })
    },
  )
  .post(
    "/impersonate",
    describeRoute({
      description: "Sign in as a user, for support. Recorded against both people.",
      responses: {
        200: {
          description: "The session cookie is now the target user's",
          content: { "application/json": { schema: resolver(adminSchemaImpersonateResponse) } },
        },
        400: { description: "The target cannot be impersonated", ...errorResponse },
        404: { description: "No such user", ...errorResponse },
      },
    }),
    validator("json", adminSchemaImpersonateRequest),
    async (c) => {
      const admin = c.var.user
      const { userId, reason } = c.req.valid("json")

      // Minted and hashed here, as everywhere else a session is created: the table stores the hash
      // and never the token, so a database leak yields nothing replayable as a cookie.
      const token = generateSessionToken()
      const result = await impersonation(db).start(
        admin.id,
        userId,
        encodeHexLowerCase(await sha256Utf8(token)),
      )

      if (!result.ok) {
        if (result.reason === "target_not_found") return throwNotFound(c, "User not found")
        return throwBadRequest(
          c,
          result.reason === "target_is_admin"
            ? "A platform admin cannot be impersonated. Ask them."
            : "Impersonation refused",
        )
      }

      const target = await db
        .selectFrom("user")
        .select("email")
        .where("id", "=", userId)
        .executeTakeFirstOrThrow()

      /*
        Audited as the admin, before the cookie changes.

        This one row is written with `actor_user_id = admin` — the only impersonation row that is,
        because starting one is an act by the admin as themselves. Everything that follows is
        written as the target with `impersonator_user_id` set, which is what makes the customer's
        own trail true rather than a lie about what they did.
      */
      await crudAuditLog(db).record({
        organizationId: null,
        actorUserId: admin.id,
        action: "admin:impersonate:start",
        resourceSrn: `srn:sproutos:iam::user/${userId}`,
        after: { targetUserId: userId, targetEmail: target.email, reason },
        ...auditContext(c),
      })

      /*
        The admin's own token is stashed before `session` is overwritten.

        There is one session cookie, so minting the impersonated one replaces it. The admin's session
        *row* is untouched and still valid — but the browser stops holding its token, so without this
        the end of an impersonation is a sign-out. Which is exactly what it was, until the flow was
        driven end to end in a browser.

        That matters more than it sounds. A support engineer who has to sign in again afterwards is
        one who leaves the next impersonated session open instead, and the sixty-minute expiry only
        helps if these sessions actually get closed.

        No new exposure: this is the same credential the browser held a moment ago, under the same
        `HttpOnly`, `Secure` and `SameSite` attributes, and it is cleared when the impersonation ends.
      */
      const cookieOptions = {
        path: "/",
        domain: cookieDomain(),
        httpOnly: true,
        sameSite: "Lax",
        secure: process.env.NODE_ENV === "production",
      } as const

      const own = getCookie(c, "session")
      if (own !== undefined) {
        setCookie(c, IMPERSONATOR_COOKIE, own, {
          ...cookieOptions,
          // Outlives the impersonated session, so ending one at the last minute still restores it.
          expires: new Date(result.expires.getTime() + 60 * 60 * 1000),
        })
      }

      setCookie(c, "session", token, { ...cookieOptions, expires: result.expires })

      return c.json({
        userId,
        email: target.email,
        expiresAt: result.expires.toISOString(),
      })
    },
  )

export default app
