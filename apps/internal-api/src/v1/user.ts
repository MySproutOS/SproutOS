import { fetchOrganization, fetchUserPreference } from "@lib/dao"
import { crudUser } from "@lib/dao/user/crud"
import { db } from "@sproutos/db"
import { Hono } from "hono"
import { describeRoute } from "hono-typebox-openapi"
import { resolver } from "hono-typebox-openapi/typebox"
import { authMiddleware } from "../middleware"
import { EmptyObject, ErrorSchemaResponse } from "../utils/common.serializer"
import { throwInternalServerError } from "../utils/http-exception"
import { userSchemaPreferencesResponse } from "./user.serializer"

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
      })
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
      if (!result) {
        return throwInternalServerError(c, "Failed to delete user")
      }

      return c.json({}, 200)
    },
  )

export default app
