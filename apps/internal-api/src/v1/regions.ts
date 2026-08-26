import { db } from "@sproutos/db"
import { Hono } from "hono"
import { describeRoute } from "hono-typebox-openapi"
import { resolver } from "hono-typebox-openapi/typebox"
import { Type } from "typebox"
import { authMiddleware } from "../middleware"

/**
 * Where a customer may put a project's data.
 *
 * This existed only as a hardcoded array in the dashboard — `["us-east-1", "us-west-2", "eu-west-1",
 * "ap-southeast-2"]` — which matched neither the seed nor reality. `ap-southeast-2` is not seeded in
 * any state, and of the seven rows that *are* seeded exactly one is `is_active`. So the settings
 * screen offered four regions, three of which would not have worked and one of which does not
 * exist.
 *
 * Serving the active set from here makes the list self-correcting: activating a region is a row
 * update, and the screen picks it up without a release. Filtering on `is_active` rather than
 * returning everything is the whole point — a region that exists in the table but has no cluster is
 * a region a customer must not be able to choose.
 */
const regionsResponse = Type.Object({
  data: Type.Array(
    Type.Object({
      code: Type.String(),
      displayName: Type.String(),
      provider: Type.String(),
    }),
  ),
})

/*
  Mounted at `/regions`, and the path here is `/`.

  Not `.route("/", regions)` with a `/regions` path inside. Mounting a sub-app at `/` applies its
  middleware to every route under `/` — which meant `authMiddleware` was suddenly running on the
  metering ingest, the OAuth token endpoint and the GitHub webhook receiver, all of which
  authenticate their callers by signature and have no session to find. Every one of them started
  answering 401.
*/
const regions = new Hono().use(authMiddleware).get(
  "/",
  describeRoute({
    description: "The regions a project's services can be placed in",
    responses: {
      200: {
        description: "Active regions",
        content: { "application/json": { schema: resolver(regionsResponse) } },
      },
    },
  }),
  async (c) => {
    const rows = await db
      .selectFrom("region")
      .select(["code", "displayName", "provider"])
      .where("isActive", "=", true)
      .orderBy("code", "asc")
      .execute()

    return c.json({ data: rows })
  },
)

export default regions
