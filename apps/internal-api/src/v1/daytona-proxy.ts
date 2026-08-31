import { fetchSandbox } from "@lib/dao"
import { sandboxForwardProxyAuthorizationSignature } from "@lib/sandbox/daytona"
import { db } from "@sproutos/db"
import { timingSafeEqual } from "node:crypto"
import { Hono } from "hono"
import { describeRoute } from "hono-typebox-openapi"
import { resolver } from "hono-typebox-openapi/typebox"
import { ErrorSchemaResponse } from "../utils/errors/error.serializer"
import { throwUnauthenticated } from "../utils/http-exception"
import { validator } from "../utils/validator"
import {
  daytonaProxyAuthorizeSchemaParam,
  daytonaProxyAuthorizeSchemaResponse,
} from "./daytona-proxy.serializer"

const SIGNATURE_HEADER = "x-daytona-proxy-signature"
const LIVE_STATES = new Set(["starting", "running", "idle"])

function validSignature(sandboxId: string, supplied: string | undefined): boolean {
  const encodedKey = process.env.SANDBOX_FORWARD_PROXY_ROOT_KEY
  if (encodedKey === undefined || supplied === undefined) return false
  let expected: string
  try {
    expected = sandboxForwardProxyAuthorizationSignature(encodedKey, sandboxId)
  } catch {
    return false
  }
  const left = Buffer.from(expected)
  const right = Buffer.from(supplied)
  return left.length === right.length && timingSafeEqual(left, right)
}

const app = new Hono().get(
  "/authorize/:id",
  describeRoute({
    description: "Authorizes a live sandbox for the standalone Daytona egress proxy",
    responses: {
      200: {
        description: "The sandbox is live and may use egress",
        content: { "application/json": { schema: resolver(daytonaProxyAuthorizeSchemaResponse) } },
      },
      401: {
        description: "The caller is invalid or the sandbox is not live",
        content: { "application/json": { schema: resolver(ErrorSchemaResponse) } },
      },
    },
  }),
  validator("param", daytonaProxyAuthorizeSchemaParam),
  async (c) => {
    const { id } = c.req.valid("param")
    if (!validSignature(id, c.req.header(SIGNATURE_HEADER))) {
      return throwUnauthenticated(c, "Sandbox proxy authorization failed")
    }
    const sandbox = await fetchSandbox(db).forForwardProxyAuthorization(id)
    if (sandbox === undefined || !LIVE_STATES.has(sandbox.state)) {
      return throwUnauthenticated(c, "Sandbox proxy authorization failed")
    }
    return c.json({
      sandboxId: sandbox.id,
      projectId: sandbox.projectId,
      organizationId: sandbox.organizationId,
      state: sandbox.state as "starting" | "running" | "idle",
    })
  },
)

export default app
