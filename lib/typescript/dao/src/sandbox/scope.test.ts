import { describe, expect, it } from "vitest"

import { sandboxScopeFor } from "./scope"

/**
 * A fake that answers the two lookups `sandboxScopeFor` makes, so the resolution rule can be tested
 * without a database. What is under test is which project id comes back, not how a row is read.
 */
function fakeDb(rows: Record<string, { id: string; parentProjectId: string | null } | undefined>) {
  return {
    selectFrom: () => {
      let wanted: string | undefined
      const q = {
        executeTakeFirst: () => Promise.resolve(wanted === undefined ? undefined : rows[wanted]),
        select: () => q,
        where: (column: string, _op: string, value: unknown) => {
          if (column === "id") wanted = value as string
          return q
        },
      }
      return q
    },
  } as never
}

describe("sandboxScopeFor", () => {
  it("gives a child its group's sandbox", async () => {
    /*
      The property this exists for. `apps/website` and `apps/internal-api` are directories in one
      checkout; a sandbox each would mean two clones, two `node_modules`, and two dev servers that
      cannot see each other.
    */
    const db = fakeDb({
      child: { id: "child", parentProjectId: "group" },
      group: { id: "group", parentProjectId: null },
    })
    expect(await sandboxScopeFor(db, "org", "child")).toBe("group")
  })

  it("gives two children of one group the same sandbox", async () => {
    const db = fakeDb({
      api: { id: "api", parentProjectId: "group" },
      group: { id: "group", parentProjectId: null },
      web: { id: "web", parentProjectId: "group" },
    })
    // Stated separately from the case above because *this* is what a customer notices: the agent
    // fixing a shared library in one and the other seeing it.
    expect(await sandboxScopeFor(db, "org", "web")).toBe(await sandboxScopeFor(db, "org", "api"))
  })

  it("leaves an ungrouped project as its own scope", async () => {
    // Projects created before repositories started as groups, and any whose group could not be
    // made. They should keep working rather than have no sandbox at all.
    const db = fakeDb({ lone: { id: "lone", parentProjectId: null } })
    expect(await sandboxScopeFor(db, "org", "lone")).toBe("lone")
  })

  it("falls back to the child when the group has been deleted", async () => {
    /*
      `parent_project_id` is `ON DELETE RESTRICT`, so a live child cannot be orphaned by a hard
      delete — but a *soft*-deleted group is still referenced, and resolving onto it would hand back
      a workspace nobody can see in the UI.
    */
    const db = fakeDb({ orphan: { id: "orphan", parentProjectId: "gone" } })
    expect(await sandboxScopeFor(db, "org", "orphan")).toBe("orphan")
  })

  it("is undefined for a project this organization does not have", async () => {
    // Not an error and not a fallback: returning the requested id would let a caller name any
    // project and get a sandbox scope for it.
    expect(await sandboxScopeFor(fakeDb({}), "org", "someone-elses")).toBeUndefined()
  })
})
