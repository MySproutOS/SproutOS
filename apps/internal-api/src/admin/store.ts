import { crudAuditLog, crudStoreListing, fetchAndroidApp, fetchStoreListing } from "@lib/dao"
import { db } from "@sproutos/db"
import { Hono } from "hono"
import { describeRoute } from "hono-typebox-openapi"
import { resolver } from "hono-typebox-openapi/typebox"
import { ErrorSchemaResponse } from "../utils/common.serializer"
import { throwBadRequest, throwNotFound } from "../utils/http-exception"
import { auditContext } from "../utils/request-context"
import { validator } from "../utils/validator"
import {
  adminSchemaAndroidReleaseRequest,
  adminSchemaAndroidReleaseResponse,
  adminSchemaStoreListingParam,
} from "./admin.serializer"
import { adminAuthMiddleware } from "./middleware"

const errorResponse = {
  content: { "application/json": { schema: resolver(ErrorSchemaResponse) } },
}

/** Global catalogue curation belongs to platform administration, never tenant RBAC. */
const app = new Hono().use(adminAuthMiddleware).post(
  "/listings/:listingId/android-release",
  describeRoute({
    description: "Selects the exact signed Android release published by a global listing",
    responses: {
      200: {
        description: "The canonical Android release, or null when removed",
        content: {
          "application/json": { schema: resolver(adminSchemaAndroidReleaseResponse) },
        },
      },
      400: { description: "Listing or release is not publishable", ...errorResponse },
      403: { description: "Caller is not a platform admin", ...errorResponse },
      404: { description: "No such listing", ...errorResponse },
    },
  }),
  validator("param", adminSchemaStoreListingParam),
  validator("json", adminSchemaAndroidReleaseRequest),
  async (c) => {
    const user = c.var.user
    const { listingId } = c.req.valid("param")
    const { androidAppId } = c.req.valid("json")

    const result = await db.transaction().execute(async (tx) => {
      const listing = await fetchStoreListing(tx).getOne(listingId, [
        "id",
        "platform",
        "status",
        "canonicalAndroidAppId",
      ])
      if (listing === undefined) return undefined

      if (androidAppId !== null) {
        if (listing.platform !== "android" || listing.status !== "published") {
          return { invalid: "Only a published Android listing can select a release" } as const
        }
        const release = await fetchAndroidApp(tx).getPublishableForListing(listingId, androidAppId)
        if (release === undefined) {
          return {
            invalid: "Release is not a ready, verified, signed app from this listing",
          } as const
        }
      }

      const row = await crudStoreListing(tx).setCanonicalAndroidRelease(listingId, androidAppId)
      if (row === undefined) return undefined
      await crudAuditLog(tx).record({
        organizationId: null,
        actorUserId: user.id,
        action: "admin:store:android-release",
        before: { listingId, canonicalAndroidAppId: listing.canonicalAndroidAppId },
        after: { listingId, canonicalAndroidAppId: row.canonicalAndroidAppId },
        ...auditContext(c),
      })
      return { androidAppId: row.canonicalAndroidAppId }
    })

    if (result === undefined) return throwNotFound(c, "Listing not found")
    if ("invalid" in result) return throwBadRequest(c, result.invalid)
    return c.json(result)
  },
)

export default app
