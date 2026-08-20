import { crudUser } from "@lib/dao/user/crud"
import { db } from "@sproutos/db"
import { Hono } from "hono"
import { describeRoute } from "hono-typebox-openapi"
import { resolver } from "hono-typebox-openapi/typebox"
import { authMiddleware } from "../middleware"
import { EmptyObject, ErrorSchemaResponse } from "../utils/common.serializer"
import { throwInternalServerError } from "../utils/http-exception"

const app = new Hono().use(authMiddleware).delete(
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
