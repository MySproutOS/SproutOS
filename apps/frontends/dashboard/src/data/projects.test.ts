import { describe, expect, it } from "vitest"
import { isStandaloneWorkflowProject, type Project } from "./projects"

function project(kind: Project["kind"], parentProjectId: string | null): Project {
  return {
    id: `${kind}-${parentProjectId ?? "standalone"}`,
    name: "Acceptance",
    glyph: "A",
    repo: "acme/acceptance",
    repoUrl: "https://github.com/acme/acceptance",
    status: "ready",
    kind,
    costMicros: 0n,
    updatedLabel: "now",
    region: "us-east-1",
    hasUpstreamUpdate: false,
    isGroup: false,
    servingMode: null,
    parentProjectId,
    managedByOauthApp: null,
    url: null,
    hostname: null,
    primaryChildProjectId: null,
    primaryUrl: null,
    primaryHostname: null,
    liveDeploymentId: null,
  }
}

describe("isStandaloneWorkflowProject", () => {
  it("routes only an ungrouped workflow repository to the organization Workflows tab", () => {
    expect(isStandaloneWorkflowProject(project("workflow", null))).toBe(true)
    expect(isStandaloneWorkflowProject(project("workflow", "group-id"))).toBe(false)
    expect(isStandaloneWorkflowProject(project("site", null))).toBe(false)
  })
})
