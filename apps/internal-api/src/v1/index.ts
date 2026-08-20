import { Hono } from "hono"
import { RegExpRouter } from "hono/router/reg-exp-router"
import auth from "./auth"
import members, { invites } from "./members"
import organizations from "./organizations"
import roles from "./roles"
import stripeWebhooks from "./stripe-webhooks"
import user from "./user"
import webhooks from "./webhooks"

const app = new Hono({
  router: new RegExpRouter(),
})
  .basePath("/v1")
  .route("/auth", auth)
  .route("/invites", invites)
  .route("/orgs", organizations)
  .route("/orgs", members)
  .route("/orgs", roles)
  .route("/user", user)
  // Unauthenticated by design: GitHub and Stripe each sign their deliveries and the handlers
  // verify over the raw bytes. Adding authMiddleware or requirePermission here would reject
  // every delivery, since neither sender carries a session.
  .route("/webhooks", webhooks)
  .route("/webhooks", stripeWebhooks)

export default app
