import { Hono } from "hono"
import { RegExpRouter } from "hono/router/reg-exp-router"
import auth from "./auth"
import user from "./user"
import webhooks from "./webhooks"

const app = new Hono({
  router: new RegExpRouter(),
})
  .basePath("/v1")
  .route("/auth", auth)
  .route("/user", user)
  .route("/webhooks", webhooks)

export default app
