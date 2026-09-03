import { Hono } from "hono"
import { RegExpRouter } from "hono/router/reg-exp-router"
import users from "./users"
import store from "./store"
import managedDomainPolicies from "./managed-domain-policies"

/**
 * The platform surface.
 *
 * Mounted separately from `/v1` and not part of the public API: these routes answer to
 * `user.is_admin` rather than to any organization's RBAC, and nothing a customer's token can hold
 * reaches them. What `is_admin` grants is defined in `docs/adr/0019-platform-admin.md`, including
 * curation of the platform-owned global store catalogue and its private acceptance bridge.
 */
const app = new Hono({
  router: new RegExpRouter(),
})
  .basePath("/admin")
  .route("/store", store)
  .route("/managed-domain-policies", managedDomainPolicies)
  .route("/users", users)

export default app
