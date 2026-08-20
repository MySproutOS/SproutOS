import { Hono } from "hono"
import { RegExpRouter } from "hono/router/reg-exp-router"
import users from "./users"

/**
 * The platform surface.
 *
 * Mounted separately from `/v1` and not part of the public API: these routes answer to
 * `user.is_admin` rather than to any organization's RBAC, and nothing a customer's token can hold
 * reaches them. What `is_admin` grants is defined in `docs/adr/0019-platform-admin.md`.
 */
const app = new Hono({
  router: new RegExpRouter(),
})
  .basePath("/admin")
  .route("/users", users)

export default app
