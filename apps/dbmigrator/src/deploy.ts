import path from "node:path"
import { fileURLToPath } from "node:url"
import { promises as fs } from "node:fs"
import { db } from "@sproutos/db"
import { sql } from "kysely"
// `kysely/migration` rather than `kysely`: the root entry point is isomorphic, and
// `FileMigrationProvider` reads the filesystem. Kysely keeps the whole migration surface behind its
// own export so a browser bundle cannot pull `node:fs` in through the main import.
import { FileMigrationProvider, Migrator } from "kysely/migration"

/**
 * Applying migrations on deploy, exactly once, from however many replicas start at once.
 *
 * A rollout starts N pods at the same time and every one of them wants the schema to be current.
 * Left alone they race: two `create table` statements collide and one pod crash-loops, or — much
 * worse — two data migrations both run and the second one operates on rows the first already
 * moved. Kysely's migration table has a unique constraint, which turns the first case into an
 * error rather than corruption, but an error at boot is still a failed rollout, and it does nothing
 * about the second case.
 *
 * A Postgres advisory lock is the right shape for this because it lives in the database the
 * migrations are being applied to. Anything else — a Kubernetes lease, a flag in Redis, an
 * init-container that only one pod runs — puts the coordination somewhere other than the resource
 * being coordinated, and then a network partition gets you two holders of a lock protecting one
 * database.
 */

/**
 * The lock key, hard-coded.
 *
 * Deliberately **not** `hashtext('sproutos:migrations')`, which would read better. `hashtext` is an
 * internal function whose output has changed between major Postgres versions; a key computed that
 * way would differ between a pod on the old version and a pod on the new one during an upgrade,
 * which is precisely the moment two migrators must not both believe they hold the lock.
 */
const LOCK_KEY = 8_012_026n

/**
 * How long to wait for the lock before giving up.
 *
 * Long enough for a real migration to finish while another pod waits, short enough that a pod stuck
 * behind a lock nobody will release fails its readiness probe rather than hanging until someone
 * looks. The waiter almost always finds there is nothing left to do.
 */
const LOCK_TIMEOUT = "10min"

export type DeployResult = {
  applied: string[]
  /** True when another process held the lock and had already applied everything. */
  waited: boolean
}

export type DeployOptions = {
  /**
   * How long to wait for the lock. A Postgres interval string.
   *
   * Configurable only so a test can assert the exclusion deterministically — a test that waited the
   * real ten minutes to prove a lock excludes is a test nobody runs.
   */
  lockTimeout?: string
}

export async function deploy(options: DeployOptions = {}): Promise<DeployResult> {
  /*
    `db.connection()` pins one connection for the callback.

    This matters: `pg_advisory_lock` is *session*-scoped, so the lock belongs to the connection that
    took it. Taking it through the pool would acquire it on whichever connection came free and
    release it on whichever came free next — which is to say, release someone else's lock, or fail
    to release ours. The migrator underneath uses other connections from the same pool, which is
    fine and is the point: the lock is a gate, not a transaction.
  */
  return await db.connection().execute(async (pinned) => {
    await sql`set lock_timeout = ${sql.lit(options.lockTimeout ?? LOCK_TIMEOUT)}`.execute(pinned)

    const before = await applied(pinned)
    await sql`select pg_advisory_lock(${sql.lit(LOCK_KEY.toString())}::bigint)`.execute(pinned)

    try {
      // Re-read after the lock. If another pod migrated while we waited, this is how we know — and
      // it is the difference between "we waited and did nothing" and "we ran and found nothing",
      // which are worth telling apart in a rollout log.
      const waited = (await applied(pinned)) !== before

      const { error, results } = await migrator().migrateToLatest()
      if (error !== undefined) {
        // Kysely types this `unknown` because a migration is arbitrary user code and may throw
        // anything. Wrapping keeps the original as `cause` rather than discarding it, and means the
        // caller always catches something with a stack.
        throw error instanceof Error
          ? error
          : // `JSON.stringify`, because an unknown thrown value is as likely to be an object as a
            // string, and `String({})` is `[object Object]` — which is the least useful thing a
            // failed rollout could put in its logs.
            new Error(`Migration failed: ${JSON.stringify(error)}`, { cause: error })
      }

      return {
        applied: (results ?? []).filter((r) => r.status === "Success").map((r) => r.migrationName),
        waited,
      }
    } finally {
      /*
        Released in a `finally`, even though the connection closing would release it anyway.

        The connection returns to the *pool* rather than closing, and a pooled connection that still
        holds an advisory lock hands that lock to whatever runs next on it — including, eventually,
        the next deploy in the same process. Relying on disconnection to clean up is relying on the
        pool to do something it is designed not to do.
      */
      await sql`select pg_advisory_unlock(${sql.lit(LOCK_KEY.toString())}::bigint)`.execute(pinned)
    }
  })
}

function migrator(): Migrator {
  return new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations"),
    }),
  })
}

/**
 * How many migrations are recorded as applied. Cheap, and enough to detect that someone else ran.
 *
 * The existence check is not defensive tidiness — without it this function throws on exactly one
 * database, and it is the one that matters most. Kysely creates `kysely_migration` lazily, inside
 * the first `migrateToLatest()`, so on a database nobody has ever migrated the table is absent and
 * `select count(*) from kysely_migration` fails to plan with `42P01`. `deploy()` calls this
 * *before* it migrates, to know whether another process got there first — so the very first deploy
 * against a new environment died before applying anything, reporting a missing table as though the
 * migrator itself were broken.
 *
 * That is precisely how production came to be running with an empty schema, answering 500 from
 * `/login/github/callback` with `relation "account" does not exist`. The tests here exercise the
 * lock against a development database that has been migrated many times, where this code path
 * cannot fail.
 *
 * `to_regclass` rather than a `try`/`catch`: it answers in one round trip and returns null instead
 * of raising, so nothing has to distinguish "table absent" from a connection that genuinely broke.
 * The name is unqualified so it resolves through `search_path`, which is what the migrator itself
 * uses to decide where to put the table.
 */
async function applied(executor: typeof db = db): Promise<number> {
  const present = await sql<{
    present: boolean
  }>`select to_regclass('kysely_migration') is not null as present`.execute(executor)

  if (!present.rows[0]?.present) return 0

  const result = await sql<{
    count: string
  }>`select count(*)::text as count from kysely_migration`.execute(executor)
  return Number(result.rows[0]?.count ?? "0")
}
