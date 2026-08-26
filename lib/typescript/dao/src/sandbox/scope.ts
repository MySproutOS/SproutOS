import type { DB } from "@sproutos/db"
import type { Kysely } from "kysely"

/**
 * Which project a sandbox belongs to.
 *
 * **The group, not the child.** A group is one repository and one checkout; its children are
 * directories inside that checkout. Giving `apps/website` and `apps/internal-api` a sandbox each
 * would mean two clones of the same repository, two `node_modules`, two dev servers that cannot
 * see each other, and an agent that fixes a shared library in one and cannot see it from the
 * other — for a monorepo, which is the shape this platform is built around, that is not isolation,
 * it is a split brain.
 *
 * So the sandbox is keyed on the group. Asking for the sandbox of a child returns the group's,
 * which is the same workspace the child's code actually lives in.
 *
 * A project with no group is its own scope. That is the ungrouped case — a project created before
 * repositories started as groups, or one whose group could not be created — and it should keep
 * working rather than have no sandbox at all.
 */
export async function sandboxScopeFor(
  db: Kysely<DB>,
  organizationId: string,
  projectId: string,
): Promise<string | undefined> {
  const project = await db
    .selectFrom("project")
    .select(["id", "parentProjectId"])
    .where("id", "=", projectId)
    .where("organizationId", "=", organizationId)
    .where("deletedAt", "is", null)
    .executeTakeFirst()

  if (project === undefined) return undefined
  if (project.parentProjectId === null) return project.id

  /*
    The parent has to still be there.

    `parent_project_id` is `ON DELETE RESTRICT`, so a live child cannot be orphaned by a delete —
    but a soft-deleted group can still be referenced, and resolving a sandbox onto a deleted row
    would hand back a workspace nobody can see in the UI.
  */
  const parent = await db
    .selectFrom("project")
    .select("id")
    .where("id", "=", project.parentProjectId)
    .where("organizationId", "=", organizationId)
    .where("deletedAt", "is", null)
    .executeTakeFirst()

  return parent?.id ?? project.id
}
