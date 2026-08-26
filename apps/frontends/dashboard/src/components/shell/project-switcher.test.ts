import { describe, expect, it } from "vitest"
import type { Project } from "@frontends/dashboard/data/projects"
import { group } from "./project-switcher"

function project(overrides: Partial<Project> & { id: string; name: string }): Project {
  return {
    glyph: "X",
    repo: "acme/repo",
    repoUrl: "https://github.com/acme/repo",
    status: "ready",
    costMicros: 0n,
    updatedLabel: "now",
    region: "us-east-1",
    hasUpstreamUpdate: false,
    isGroup: false,
    parentProjectId: null,
    url: null,
    liveDeploymentId: null,
    ...overrides,
  }
}

const REDDIT = project({ id: "g1", name: "reddit-clone", isGroup: true })
const WEB = project({ id: "p1", name: "web", parentProjectId: "g1" })
const API = project({ id: "p2", name: "internal-api", parentProjectId: "g1" })
const OTHER = project({ id: "g2", name: "toyourcredit", isGroup: true })
const OTHER_API = project({ id: "p3", name: "internal-api", parentProjectId: "g2" })
const LOOSE = project({ id: "p4", name: "glance-fork-test" })

const ALL = [REDDIT, WEB, API, OTHER, OTHER_API, LOOSE]

describe("group", () => {
  it("nests children under their group and keeps ungrouped projects separate", () => {
    const sections = group(ALL, "")

    expect(sections.map((section) => section.header?.name ?? null)).toEqual([
      "reddit-clone",
      "toyourcredit",
      null,
    ])
    expect(sections[0]?.children.map((child) => child.name)).toEqual(["web", "internal-api"])
    expect(sections[2]?.children.map((child) => child.name)).toEqual(["glance-fork-test"])
  })

  /*
    The failure a flat filter produces.

    Two repositories both have an `internal-api`. Matching on the child alone gives two identical
    rows, and without their headers there is no way to tell which is which — so the header has to
    survive even though it does not match the query itself.
  */
  it("keeps the parent header when only a child matches", () => {
    const sections = group(ALL, "internal-api")

    expect(sections).toHaveLength(2)
    expect(sections[0]?.header?.name).toBe("reddit-clone")
    expect(sections[1]?.header?.name).toBe("toyourcredit")
    // Present for context, and not selectable — it is not what was searched for.
    expect(sections[0]?.headerIsContext).toBe(true)
    expect(sections[1]?.headerIsContext).toBe(true)
  })

  it("marks the header selectable when the group itself matched", () => {
    const sections = group(ALL, "reddit")

    expect(sections).toHaveLength(1)
    expect(sections[0]?.header?.name).toBe("reddit-clone")
    expect(sections[0]?.headerIsContext).toBe(false)
  })

  it("drops a group entirely when neither it nor its children match", () => {
    const sections = group(ALL, "glance")

    expect(sections.map((section) => section.header?.name ?? null)).toEqual([null])
    expect(sections[0]?.children.map((child) => child.name)).toEqual(["glance-fork-test"])
  })

  /** A child whose group is not in the list is shown loose rather than silently dropped. */
  it("does not lose a child whose group is missing", () => {
    const orphan = project({ id: "p9", name: "stray", parentProjectId: "missing" })
    const sections = group([orphan], "")

    expect(sections).toHaveLength(1)
    expect(sections[0]?.children.map((child) => child.name)).toEqual(["stray"])
  })
})
