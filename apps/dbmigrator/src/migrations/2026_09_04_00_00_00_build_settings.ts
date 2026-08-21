import type { Kysely } from "kysely"
import { sql } from "kysely"

/**
 * Where the Dockerfile is — on the project, and on the store listing that seeds it.
 *
 * The builder ran `buildctl --frontend=dockerfile.v0 --opt=context=<repo>#<sha>` and nothing else,
 * so it looked for `Dockerfile` at the repository root and could build nothing that keeps one
 * anywhere else. Of the six applications in the store's own catalogue, two do. The other four fork
 * successfully, build, and fail with `failed to read dockerfile: open Dockerfile: no such file or
 * directory` — a platform whose premise is "fork an open source app and it deploys" against a
 * catalogue two thirds of which cannot.
 *
 * `project.root_dir` was already there and already meant the right thing; it simply had no reader
 * (see the note on `BuildSpec.contextSubdir`). `dockerfile_path` is the fact it could not express:
 * `docker/Dockerfile` is a path *to a file*, not a directory to build from, and a monorepo that
 * builds `apps/web` with a root Dockerfile needs both to be independent.
 *
 * The listing carries the same two columns because that is where the knowledge lives. A customer
 * forking Memos has no reason to know where its Dockerfile is, and asking them is asking them to do
 * the one thing the store exists to save them from. `provisionProject` copies them onto the project
 * at fork time, so they remain the customer's to change afterwards.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table project
      add column dockerfile_path text not null default 'Dockerfile'
  `.execute(db)

  await sql`
    alter table store_listing
      add column root_dir text not null default '.',
      add column dockerfile_path text not null default 'Dockerfile'
  `.execute(db)

  /*
    A path, not a directory and not an absolute one.

    An empty string would send BuildKit looking for a file with no name, and a leading `/` would
    resolve outside the build context — both of which fail deep inside the build with a message
    about the frontend rather than about the setting that caused it.
  */
  await sql`
    alter table project
      add constraint project_dockerfile_path_check
      check (dockerfile_path <> '' and dockerfile_path not like '/%' and dockerfile_path not like '%..%')
  `.execute(db)

  await sql`
    alter table store_listing
      add constraint store_listing_dockerfile_path_check
      check (dockerfile_path <> '' and dockerfile_path not like '/%' and dockerfile_path not like '%..%')
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table store_listing drop constraint store_listing_dockerfile_path_check`.execute(
    db,
  )
  await sql`alter table project drop constraint project_dockerfile_path_check`.execute(db)
  await sql`alter table store_listing drop column dockerfile_path, drop column root_dir`.execute(db)
  await sql`alter table project drop column dockerfile_path`.execute(db)
}
