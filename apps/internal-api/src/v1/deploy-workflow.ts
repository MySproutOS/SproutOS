import { db } from "@sproutos/db"
import { Hono } from "hono"
import { describeRoute } from "hono-typebox-openapi"
import { resolver } from "hono-typebox-openapi/typebox"
import { Type } from "typebox"
import { authMiddleware } from "../middleware"
import { paramResource, requirePermission } from "../rbac"
import { throwBadRequest, throwNotFound } from "../utils/http-exception"

/**
 * The workflow a customer has to add, generated for their project.
 *
 * Nothing in the product ever produced this. The deploy action's server side has been complete for
 * some time — OIDC exchange, upload URL, release — and a customer was expected to hand-write the
 * YAML that calls it, from documentation, with no example naming their project. Every deployment in
 * the production account failed with "No build artifact was uploaded for this release", which is
 * exactly what a repository with no workflow looks like from the platform's side.
 *
 * Returned as text to copy rather than committed for them. Committing needs `contents: write` on the
 * installation and writes to a branch somebody has to review anyway; showing it is useful with the
 * permissions we already have, and is the difference between a customer who can act and one who has
 * to go and read a manual.
 */

const workflowResponse = Type.Object({
  /** The file's path, so the instruction is complete rather than "put this somewhere". */
  path: Type.String(),
  contents: Type.String(),
  /** Set when the repository holds several projects, because then `project` is not optional. */
  projectRequired: Type.Boolean(),
})

/**
 * Which preset builds this project.
 *
 * Guessed from the project's kind and directory, and *stated* in the file as a guess — the customer
 * knows what they built and we do not. A wrong preset produces a clear failure from the action
 * ("Nothing at '.next/standalone'"), which is a much better outcome than silently choosing `static`
 * and deploying a server-side application as a folder of files.
 */
export function presetFor(rootDir: string): "next" | "hono" | "static" {
  // This repository convention is intentionally structural rather than a list of product names:
  // `apps/frontends/dashboard` and `apps/frontends/admin` are both browser-only Vite builds, while
  // a directory merely named `dashboard` could still be a Next.js application.
  if (/(^|\/)frontends(\/|$)/.test(rootDir) || /(^|\/)(?:[^/]+-)?spa$/.test(rootDir)) {
    return "static"
  }
  if (/(^|\/)(web|website|frontend|www)$/.test(rootDir)) return "next"
  if (/(^|\/)(api|internal-api|server|backend)$/.test(rootDir)) return "hono"
  return "next"
}

export function workflowFor(input: {
  slug: string
  rootDir: string
  productionBranch: string
  apiUrl: string
  several: boolean
}): string {
  const preset = presetFor(input.rootDir)
  const directory =
    preset === "next"
      ? `${input.rootDir === "." ? "" : `${input.rootDir}/`}.next/standalone`
      : `${input.rootDir === "." ? "" : `${input.rootDir}/`}dist`

  return `# Deploys ${input.slug} to SproutOS on every push to ${input.productionBranch}.
#
# Generated for this project. Two things are worth reading rather than pasting:
#
#   preset      guessed from this project's directory. You know what you built; we do not.
#   directory   where your build output lands. Change it if your build writes elsewhere.
name: Deploy ${input.slug}

on:
  push:
    branches: [${input.productionBranch}]

permissions:
  contents: read
  # Required. Without it there is no OIDC token and the deploy fails at its first step with an
  # authentication error that does not mention permissions.
  id-token: write

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5

      # Replace with whatever builds this project. The deploy action uploads output; it does not
      # build.
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: npm ci
      - run: npm run build

      - uses: MySproutOS/sproutos-deploy-action@v1
        with:
          preset: ${preset}
          runtime: nodejs24.x
          handler: run.sh
          directory: ${directory}
${
  input.several
    ? `          # Required: this repository holds more than one SproutOS project, and the platform
          # refuses to guess which one a workflow deploys.
          project: ${input.slug}\n`
    : `          project: ${input.slug}\n`
}          api-url: ${input.apiUrl}
`
}

const app = new Hono().use(authMiddleware)

const routes = app.get(
  "/:orgSlug/projects/:projectId/deploy-workflow",
  describeRoute({
    description: "The GitHub Actions workflow that deploys this project, generated for it",
    responses: {
      200: {
        description: "A workflow file to add to the repository",
        content: { "application/json": { schema: resolver(workflowResponse) } },
      },
      400: { description: "A group has nothing to deploy" },
      404: { description: "No such project in this organization" },
    },
  }),
  requirePermission("project:read", paramResource("project", "project", "projectId")),
  async (c) => {
    const project = await db
      .selectFrom("project")
      .select(["id", "slug", "rootDir", "productionBranch", "isGroup", "repositoryId"])
      .where("id", "=", c.req.param("projectId"))
      .where("organizationId", "=", c.var.organization.id)
      .where("deletedAt", "is", null)
      .executeTakeFirst()

    if (project === undefined) return throwNotFound(c, "Project not found")
    if (project.isGroup) {
      return throwBadRequest(
        c,
        "A group holds other projects and deploys nothing itself. Each of its projects has its own " +
          "workflow.",
      )
    }

    /*
      Whether `project` is optional in the file we hand over.

      It is always written, because an explicit name is right either way. What changes is the
      comment above it: with one project in the repository, omitting it works; with several, the
      exchange refuses rather than guessing, and a customer who deletes the line should know that.
    */
    const siblings = await db
      .selectFrom("project")
      .select("id")
      .where("repositoryId", "=", project.repositoryId)
      .where("organizationId", "=", c.var.organization.id)
      .where("isGroup", "=", false)
      .where("deletedAt", "is", null)
      .execute()

    return c.json({
      path: `.github/workflows/sproutos-${project.slug}.yml`,
      contents: workflowFor({
        slug: project.slug,
        rootDir: project.rootDir,
        productionBranch: project.productionBranch,
        apiUrl: process.env.NEXT_PUBLIC_API_URL ?? "https://api.sproutos.me",
        several: siblings.length > 1,
      }),
      projectRequired: siblings.length > 1,
    })
  },
)

export default routes
