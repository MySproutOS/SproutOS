import type { DB } from "@sproutos/db"
import type { Kysely, Selectable } from "kysely"

/**
 * Reads of the `user` row itself.
 *
 * `user/` had `crud`, `auth`, `export` and `impersonation` but no `fetch`, which the DAO convention
 * says every table gets — so a route that wanted a field the session does not carry had nowhere to
 * ask. `authMiddleware` puts `id`, `isAdmin`, `name` and `email` on the context, deliberately: it
 * runs on every request and widening it would make every request pay for columns almost none of
 * them read.
 *
 * `github_login` is the one that prompted this. Deciding where to fork a repository needs it, and
 * a route reaching for `db.selectFrom("user")` is exactly what `AGENTS.md` forbids.
 *
 * No `deleted_at` filter. A deleted user's rows are purged by the retention sweep rather than
 * hidden, and a caller here is resolving a foreign key — an invisible row would look like a
 * dangling reference.
 */
export function fetchUser(db: Kysely<DB>) {
  async function getOne<T extends (keyof DB["user"])[]>(
    id: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["user"]>, T[number]> | undefined> {
    return await db.selectFrom("user").select(fields).where("id", "=", id).executeTakeFirst()
  }

  async function getByGithubLogin<T extends (keyof DB["user"])[]>(
    login: string,
    fields: T,
  ): Promise<Pick<Selectable<DB["user"]>, T[number]> | undefined> {
    return await db
      .selectFrom("user")
      .select(fields)
      .where("githubLogin", "=", login)
      .executeTakeFirst()
  }

  return { getOne, getByGithubLogin }
}
