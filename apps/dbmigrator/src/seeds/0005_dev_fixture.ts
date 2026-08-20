import type { Kysely } from "kysely"

/**
 * Fixed ids so the fixture is idempotent and so dev tooling can hard-code them. They are
 * well-formed UUIDv7 values (version nibble 7, variant 8) with a frozen timestamp prefix.
 */
const DEV = {
  userId: "01991000-0000-7000-8000-000000000001",
  organizationId: "01991000-0000-7000-8000-000000000002",
  organizationMemberId: "01991000-0000-7000-8000-000000000003",
  userPreferenceId: "01991000-0000-7000-8000-000000000004",
  repositoryId: "01991000-0000-7000-8000-000000000005",
  projectId: "01991000-0000-7000-8000-000000000006",
} as const

export async function seed(db: Kysely<any>): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    return
  }

  await db
    .insertInto("user")
    .values({
      id: DEV.userId,
      name: "Dev User",
      email: "dev@sproutos.dev",
      github_login: "sproutos-dev",
      github_user_id: 1,
      is_admin: true,
    })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute()

  await db
    .insertInto("organization")
    .values({
      id: DEV.organizationId,
      slug: "dev-team",
      name: "Dev User's Team",
      kind: "personal",
      owner_user_id: DEV.userId,
    })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute()

  await db
    .insertInto("organization_member")
    .values({
      id: DEV.organizationMemberId,
      organization_id: DEV.organizationId,
      user_id: DEV.userId,
      status: "active",
    })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute()

  await db
    .insertInto("user_preference")
    .values({
      id: DEV.userPreferenceId,
      user_id: DEV.userId,
      last_org_id: DEV.organizationId,
    })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute()

  await db
    .insertInto("repository")
    .values({
      id: DEV.repositoryId,
      organization_id: DEV.organizationId,
      github_repo_id: 900000001,
      owner_login: "sproutos-dev",
      name: "hello-sprout",
      default_branch: "main",
      private: false,
      is_fork: false,
      provenance: "new",
    })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute()

  await db
    .insertInto("project")
    .values({
      id: DEV.projectId,
      organization_id: DEV.organizationId,
      repository_id: DEV.repositoryId,
      name: "Hello Sprout",
      slug: "hello-sprout",
      kind: "site",
      state: "ready",
    })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute()
}
