import { exportUser, fetchOrganization, fetchUserPreference } from "@lib/dao"
import { crudUser } from "@lib/dao/user/crud"
import { db } from "@sproutos/db"
import { Hono } from "hono"
import { deleteCookie } from "hono/cookie"
import { describeRoute } from "hono-typebox-openapi"
import { resolver, validator } from "hono-typebox-openapi/typebox"
import { v7 } from "uuid"
import { authMiddleware } from "../middleware"
import { cookieDomain } from "../utils/env"
import { EmptyObject, ErrorSchemaResponse } from "../utils/common.serializer"
import { throwBadRequest, throwConflict, throwNotFound } from "../utils/http-exception"
import {
  userSchemaExportResponse,
  userSchemaPreferencesResponse,
  userSchemaProfileResponse,
  userSchemaUpdateProfileRequest,
} from "./user.serializer"

const errorResponse = {
  content: { "application/json": { schema: resolver(ErrorSchemaResponse) } },
}

const app = new Hono()
  .use(authMiddleware)
  .get(
    "/me/preferences",
    describeRoute({
      description: "The caller's UI preferences and the organization to land them in",
      responses: {
        200: {
          description: "The caller's preferences",
          content: {
            "application/json": { schema: resolver(userSchemaPreferencesResponse) },
          },
        },
      },
    }),
    async (c) => {
      const user = c.var.user

      const preference = await fetchUserPreference(db).getForUser(user.id, [
        "sidebarCollapsed",
        "navPinnedProjectIds",
        "timezone",
        "productEmails",
      ])

      // `last_org_id` is authoritative only while it still points at a live membership: the column
      // is `ON DELETE SET NULL`, but nothing clears it when the user is merely removed from a team
      // (ADR 0004). When it does not resolve, fall back deterministically — their personal
      // organization first, then the oldest team they belong to — so a user with three teams lands
      // somewhere stable rather than on whichever row happened to sort first.
      const landing =
        (await fetchUserPreference(db).getLastOrganization(user.id)) ??
        (await fetchOrganization(db).getFallbackForUser(user.id))

      return c.json({
        lastOrganizationId: landing?.id ?? null,
        lastOrganizationSlug: landing?.slug ?? null,
        sidebarCollapsed: preference?.sidebarCollapsed ?? false,
        navPinnedProjectIds: preference?.navPinnedProjectIds ?? [],
        // The defaults a user who has never opened the settings screen gets. They match the column
        // defaults, so a row that does not exist yet and a row that was just created read alike.
        timezone: preference?.timezone ?? "UTC",
        productEmails: preference?.productEmails ?? false,
      })
    },
  )
  .get(
    "/me/profile",
    describeRoute({
      description: "The caller's identity and the preferences that belong to them",
      responses: {
        200: {
          description: "Profile",
          content: { "application/json": { schema: resolver(userSchemaProfileResponse) } },
        },
      },
    }),
    async (c) => {
      const user = c.var.user
      const [row, preference] = await Promise.all([
        db
          .selectFrom("user")
          .select(["name", "email", "createdAt"])
          .where("id", "=", user.id)
          .executeTakeFirstOrThrow(),
        fetchUserPreference(db).getForUser(user.id, ["timezone", "productEmails"]),
      ])

      return c.json({
        // `user.name` is nullable — GitHub does not require a display name. The email is the only
        // thing every account definitely has, so it is what a blank name falls back to.
        name: row.name ?? row.email,
        email: row.email,
        timezone: preference?.timezone ?? "UTC",
        productEmails: preference?.productEmails ?? false,
        createdAt: row.createdAt.toISOString(),
      })
    },
  )
  .patch(
    "/me/profile",
    describeRoute({
      description: "Update the caller's name and preferences",
      responses: {
        200: {
          description: "The profile as it now stands",
          content: { "application/json": { schema: resolver(userSchemaProfileResponse) } },
        },
        400: { description: "An unknown timezone", ...errorResponse },
      },
    }),
    validator("json", userSchemaUpdateProfileRequest),
    async (c) => {
      const user = c.var.user
      const body = c.req.valid("json")

      if (body.name !== undefined) {
        await db
          .updateTable("user")
          .set({ name: body.name.trim(), updatedAt: new Date() })
          .where("id", "=", user.id)
          .execute()
      }

      const preferenceFields = {
        ...(body.timezone === undefined ? {} : { timezone: body.timezone }),
        ...(body.productEmails === undefined ? {} : { productEmails: body.productEmails }),
        ...(body.sidebarCollapsed === undefined ? {} : { sidebarCollapsed: body.sidebarCollapsed }),
      }

      if (Object.keys(preferenceFields).length > 0) {
        try {
          /*
            Upsert, because a user has no preference row until they change something.

            Creating one at signup would be a row per account that mostly holds defaults, and a
            signup path with one more thing to fail at.
          */
          await db
            .insertInto("userPreference")
            .values({ id: v7(), userId: user.id, ...preferenceFields })
            .onConflict((conflict) =>
              conflict.column("userId").doUpdateSet({ ...preferenceFields, updatedAt: new Date() }),
            )
            .execute()
        } catch (cause) {
          /*
            The database is the authority on what a timezone is — it checks against
            `pg_timezone_names`, the same list `at time zone` accepts. Catching it here turns a 500
            into the 400 it actually is.
          */
          if (String(cause).includes("unknown timezone")) {
            return throwBadRequest(c, `\`${body.timezone}\` is not a timezone this platform knows`)
          }
          throw cause
        }
      }

      const [row, preference] = await Promise.all([
        db
          .selectFrom("user")
          .select(["name", "email", "createdAt"])
          .where("id", "=", user.id)
          .executeTakeFirstOrThrow(),
        fetchUserPreference(db).getForUser(user.id, ["timezone", "productEmails"]),
      ])

      return c.json({
        name: row.name ?? row.email,
        email: row.email,
        timezone: preference?.timezone ?? "UTC",
        productEmails: preference?.productEmails ?? false,
        createdAt: row.createdAt.toISOString(),
      })
    },
  )
  .get(
    "/me/export",
    describeRoute({
      description: "Everything the platform holds about the caller, as a downloadable document",
      responses: {
        200: {
          description: "The caller's data",
          content: { "application/json": { schema: resolver(userSchemaExportResponse) } },
        },
        404: { description: "No such user", ...errorResponse },
      },
    }),
    async (c) => {
      const user = c.var.user

      const document = await exportUser(db).forUser(user.id)
      if (document === null) return throwNotFound(c, "User not found")

      /*
        `Content-Disposition: attachment`, so a browser saves it rather than rendering it.

        This is the one endpoint whose response is a *file* rather than a view: the right of access
        is satisfied by handing someone a document they keep, and a JSON blob rendered in a tab is
        not that. The filename carries the date because a person exercising this right twice wants
        to be able to tell the two apart.
      */
      const day = new Date().toISOString().slice(0, 10)
      c.header("Content-Disposition", `attachment; filename="sproutos-export-${day}.json"`)

      return c.json(document)
    },
  )
  .delete(
    "/me/delete",
    describeRoute({
      responses: {
        200: {
          description: "User successfully deleted",
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
      const user = c.var.user

      const result = await crudUser(db).deleteUser(user.id)

      if (!result.ok && result.reason === "not_found") {
        return throwNotFound(c, "User not found")
      }
      if (!result.ok) {
        /*
          409, and it names the organizations.

          Someone has to be responsible for a team's data and its bill. Orphaning them or cascading
          the delete are both worse than saying so, and a message that does not say *which* teams
          leaves the person to guess.
        */
        return throwConflict(
          c,
          `Transfer or delete these organizations first: ${result.organizations
            .map((organization) => organization.slug)
            .join(", ")}`,
        )
      }

      // The cookie goes with the account. Without this the browser keeps a session token whose
      // row was just deleted, and the next request is a confusing 401 rather than a sign-out.
      deleteCookie(c, "session", { path: "/", domain: cookieDomain() })

      return c.json({}, 200)
    },
  )

export default app
