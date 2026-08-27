import { parse } from "yaml"
import { describe, expect, it } from "vitest"
import { presetFor, workflowFor } from "./deploy-workflow"

const base = {
  slug: "reddit-clone-web",
  rootDir: "apps/website",
  productionBranch: "main",
  apiUrl: "https://api.sproutos.me",
  several: true,
}

describe("the generated deploy workflow", () => {
  /*
    Parsed, not string-matched.

    `toContain("id-token: write")` passes on a file whose indentation is wrong, which is the way a
    generated YAML file actually breaks — GitHub rejects the workflow and the customer sees a syntax
    error in a file they did not write. Parsing is the only assertion that catches that.
  */
  it("is valid YAML with the structure GitHub expects", () => {
    const document = parse(workflowFor(base)) as {
      name: string
      on: { push: { branches: string[] } }
      permissions: Record<string, string>
      jobs: { deploy: { steps: { uses?: string; with?: Record<string, string> }[] } }
    }

    expect(document.permissions).toMatchObject({ contents: "read", "id-token": "write" })
    expect(document.on.push.branches).toEqual(["main"])

    const step = document.jobs.deploy.steps.find((s) =>
      String(s.uses ?? "").includes("sproutos-deploy-action"),
    )
    expect(step?.with).toMatchObject({
      preset: "next",
      directory: "apps/website/.next/standalone",
      project: "reddit-clone-web",
    })
  })

  /*
    The one that costs an afternoon when it is missing.

    Without `id-token: write` there is no OIDC token, and the deploy fails at its first step with an
    authentication error that never mentions permissions. An action cannot grant it — a workflow
    grants its own — so the generated file has to carry it.
  */
  it("requests id-token: write", () => {
    expect(workflowFor(base)).toContain("id-token: write")
  })

  /*
    The one that deploys onto the wrong service.

    A repository holding several projects has an ambiguous token exchange; the platform refuses
    rather than guessing, so the file must name the project.
  */
  it("names the project", () => {
    expect(workflowFor(base)).toContain("project: reddit-clone-web")
  })

  it("says the project is required when the repository holds several", () => {
    expect(workflowFor(base)).toContain("refuses to guess")
    expect(workflowFor({ ...base, several: false })).not.toContain("refuses to guess")
  })

  it("triggers on the project's own production branch, not a hardcoded main", () => {
    const contents = workflowFor({ ...base, productionBranch: "develop" })
    expect(contents).toContain("branches: [develop]")
    expect(contents).not.toContain("branches: [main]")
  })

  /*
    The build directory has to be under the project's root.

    A monorepo's website writes `apps/website/.next/standalone`, and a generated file pointing at
    `.next/standalone` fails with "Nothing at ...", which reads as the customer's build being wrong.
  */
  it("roots the build directory at the project's directory", () => {
    expect(workflowFor(base)).toContain("directory: apps/website/.next/standalone")
  })

  it("does not prefix the directory for a project at the repository root", () => {
    expect(workflowFor({ ...base, rootDir: "." })).toContain("directory: .next/standalone")
  })
})

describe("presetFor", () => {
  it("recognises a web app", () => {
    expect(presetFor("apps/website")).toBe("next")
    expect(presetFor("apps/web")).toBe("next")
  })

  it("recognises an API", () => {
    expect(presetFor("apps/internal-api")).toBe("hono")
    expect(presetFor("apps/api")).toBe("hono")
  })

  it("recognises browser-only frontend workspaces", () => {
    expect(presetFor("apps/frontends/dashboard")).toBe("static")
    expect(presetFor("apps/frontends/admin")).toBe("static")
    expect(presetFor("apps/customer-spa")).toBe("static")
    expect(workflowFor({ ...base, rootDir: "apps/frontends/admin" })).toContain(
      "directory: apps/frontends/admin/dist",
    )
  })

  /*
    A guess, and the file says so.

    Getting it wrong produces a clear refusal from the action rather than a silent mis-deploy, which
    is why guessing is acceptable here at all.
  */
  it("falls back rather than refusing", () => {
    expect(presetFor("services/thing")).toBe("next")
  })
})
