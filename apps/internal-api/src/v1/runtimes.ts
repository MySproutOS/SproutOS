import { RUNTIME_CATALOGUE, isSupportedRuntime } from "@lib/lambda"
import { Hono } from "hono"
import { describeRoute } from "hono-typebox-openapi"
import { resolver } from "hono-typebox-openapi/typebox"
import { authMiddleware } from "../middleware"
import { runtimeCatalogueResponse } from "./runtimes.serializer"

const runtimes = new Hono().use(authMiddleware).get(
  "/",
  describeRoute({
    description: "Lambda ZIP runtimes that SproutOS recognizes and their lifecycle metadata",
    responses: {
      200: {
        description: "Runtime catalogue",
        content: { "application/json": { schema: resolver(runtimeCatalogueResponse) } },
      },
    },
  }),
  (c) =>
    c.json({
      data: RUNTIME_CATALOGUE.map((entry) => ({
        ...entry,
        selectionEndsAt: "selectionEndsAt" in entry ? entry.selectionEndsAt : null,
        selectable: isSupportedRuntime(entry.id),
      })),
    }),
)

export default runtimes
