import { renderPublicSproutosSkill } from "@lib/agent/skill"
import { Hono } from "hono"

const app = new Hono().get("/", (c) =>
  c.body(
    renderPublicSproutosSkill({
      apiUrl: process.env.API_PUBLIC_URL ?? "https://api.sproutos.me",
      tenantDomain: process.env.TENANT_DOMAIN ?? "sproutos.run",
    }),
    200,
    {
      "Content-Disposition": 'inline; filename="SKILL.md"',
      "Content-Type": "text/markdown; charset=utf-8",
    },
  ),
)

export default app
