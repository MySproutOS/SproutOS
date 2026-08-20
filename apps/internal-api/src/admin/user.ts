import { Hono } from "hono"
import { adminAuthMiddleware } from "./middleware"
import { describeRoute } from "hono-typebox-openapi"
import { resolver } from "hono-typebox-openapi/typebox"
import { EmptyObject } from "../utils/common.serializer"

const app = new Hono().use(adminAuthMiddleware).get(
  "/test",
  describeRoute({
    description: "Get messages for a company job posting chat",
    responses: {
      200: {
        description: "Success",
        content: {
          "application/json": { schema: resolver(EmptyObject) },
        },
      },
    },
  }),
  (c) => {
    return c.json({})
  },
)

export default app
