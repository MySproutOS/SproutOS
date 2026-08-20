import { db } from "@sproutos/db"
import { throwBadRequest } from "../utils/http-exception"
import { Hono } from "hono"
import { deleteCookie } from "hono/cookie"
import { describeRoute } from "hono-typebox-openapi"
import { resolver } from "hono-typebox-openapi/typebox"
import { Type } from "typebox"
import { authMiddleware, authNoThrowMiddleware } from "../middleware"
import { cookieDomain } from "../utils/env"
import { EmptyObject, ErrorSchemaResponse, Nullable } from "../utils/common.serializer"

const AuthMeResponseT = Type.Object({
  user: Nullable(
    Type.Object({
      id: Type.String(),
      name: Nullable(Type.String()),
      email: Type.String(),
      isAdmin: Type.Boolean(),
    }),
  ),
})

const app = new Hono()
  .get(
    "/me",
    authNoThrowMiddleware,
    describeRoute({
      responses: {
        200: {
          description: "Current authenticated user or null",
          content: {
            "application/json": {
              schema: resolver(AuthMeResponseT),
            },
          },
        },
      },
    }),
    (c) => {
      const user = c.var.user
      return c.json({ user: user ?? null }, 200)
    },
  )
  .use(authMiddleware)
  .post(
    "/logout",
    describeRoute({
      responses: {
        200: {
          description: "Successfully logged out",
          content: {
            "application/json": {
              schema: resolver(EmptyObject),
            },
          },
        },
        500: {
          description: "",
          content: {
            "application/json": {
              schema: resolver(ErrorSchemaResponse),
            },
          },
        },
      },
    }),
    async (c) => {
      /*
        Logging out is a cookie operation, and a bearer credential has no cookie to clear.

        A caller holding an API key that POSTs here would otherwise get a 500 on a null session.
        Revoking a key is a different action with a different endpoint, and saying so beats
        pretending this did something.
      */
      const session = c.var.session
      if (session === null) {
        return throwBadRequest(c, "Sign out applies to a browser session, not to an API key")
      }
      await db.deleteFrom("session").where("sessionKey", "=", session.sessionKey).execute()
      // Domain must match the one the website set the cookie with, or it survives logout.
      deleteCookie(c, "session", { path: "/", domain: cookieDomain() })
      return c.json({}, 200)
    },
  )

export default app
