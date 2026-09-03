import type { DB } from "@sproutos/db"
import type { Kysely, Selectable } from "kysely"

export const SAFE_ACCOUNT_FIELDS = [
  "id",
  "provider",
  "displayIdentity",
  "scopes",
  "createdAt",
  "updatedAt",
] as const satisfies readonly (keyof DB["account"])[]

export function fetchAccount(db: Kysely<DB>) {
  async function getOne<T extends (keyof DB["account"])[]>(
    id: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["account"]>, T[number]> | undefined> {
    return await db.selectFrom("account").select(fields).where("id", "=", id).executeTakeFirst()
  }

  async function getForUser<T extends (keyof DB["account"])[]>(
    userId: string,
    id: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["account"]>, T[number]> | undefined> {
    return await db
      .selectFrom("account")
      .select(fields)
      .where("id", "=", id)
      .where("userId", "=", userId)
      .executeTakeFirst()
  }

  async function findByProviderIdentity<T extends (keyof DB["account"])[]>(
    provider: string,
    providerAccountId: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["account"]>, T[number]> | undefined> {
    return await db
      .selectFrom("account")
      .select(fields)
      .where("provider", "=", provider)
      .where("providerAccountId", "=", providerAccountId)
      .executeTakeFirst()
  }

  async function listSignInMethods(userId: string) {
    return await db
      .selectFrom("account")
      .select(SAFE_ACCOUNT_FIELDS)
      .where("userId", "=", userId)
      .where("provider", "in", ["google", "github"])
      .orderBy("createdAt", "asc")
      .execute()
  }

  async function lockSignInMethods(userId: string) {
    return await db
      .selectFrom("account")
      .select(SAFE_ACCOUNT_FIELDS)
      .where("userId", "=", userId)
      .where("provider", "in", ["google", "github"])
      .orderBy("createdAt", "asc")
      .forUpdate()
      .execute()
  }

  async function countSignInMethods(userId: string): Promise<number> {
    const row = await db
      .selectFrom("account")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("userId", "=", userId)
      .where("provider", "in", ["google", "github"])
      .executeTakeFirstOrThrow()
    return Number(row.count)
  }

  async function newestGithubIdentity<T extends (keyof DB["account"])[]>(
    userId: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["account"]>, T[number]> | undefined> {
    return await db
      .selectFrom("account")
      .select(fields)
      .where("userId", "=", userId)
      .where("provider", "=", "github")
      .orderBy("updatedAt", "desc")
      .orderBy("id", "desc")
      .executeTakeFirst()
  }

  async function hasGithubDependentWork(userId: string): Promise<boolean> {
    const row = await db
      .selectFrom("projectJob")
      .innerJoin(
        "organizationMember",
        "organizationMember.organizationId",
        "projectJob.organizationId",
      )
      .select("projectJob.id")
      .where("organizationMember.userId", "=", userId)
      .where("organizationMember.status", "=", "active")
      .where("projectJob.kind", "in", ["provision", "fork"])
      .where("projectJob.state", "in", ["queued", "running"])
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom("githubInstallation")
              .select("githubInstallation.id")
              .whereRef("githubInstallation.organizationId", "=", "projectJob.organizationId")
              .where("githubInstallation.deletedAt", "is", null)
              .where("githubInstallation.suspendedAt", "is", null),
          ),
        ),
      )
      .executeTakeFirst()
    return row !== undefined
  }

  return {
    countSignInMethods,
    findByProviderIdentity,
    getForUser,
    getOne,
    hasGithubDependentWork,
    listSignInMethods,
    lockSignInMethods,
    newestGithubIdentity,
  }
}
