import { Hono } from "hono"
import { RegExpRouter } from "hono/router/reg-exp-router"
import agent from "./agent"
import agentChat from "./agent-chat"
import analysis from "./analysis"
import auth from "./auth"
import billing from "./billing"
import githubRepos from "./github-repos"
import members, { invites } from "./members"
import organizations from "./organizations"
import projects from "./projects"
import roles from "./roles"
import services from "./services"
import store, { storeModeration } from "./store"
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
  .route("/orgs", projects)
  .route("/orgs", githubRepos)
  .route("/orgs", agent)
  .route("/orgs", agentChat)
  .route("/orgs", services)
  .route("/orgs", analysis)
  .route("/orgs/:orgSlug/billing", billing)
  // The catalogue itself is public (TASK 4); only moderation is org-scoped, and it is mounted
  // under /orgs so the organization whose grants apply is named in the path rather than inferred
  // from `user_preference.last_org_id`.
  .route("/store", store)
  .route("/orgs", storeModeration)
  .route("/user", user)
  // Unauthenticated by design: GitHub and Stripe each sign their deliveries and the handlers
  // verify over the raw bytes. Adding authMiddleware or requirePermission here would reject
  // every delivery, since neither sender carries a session.
  .route("/webhooks", webhooks)
  .route("/webhooks", stripeWebhooks)

export default app
