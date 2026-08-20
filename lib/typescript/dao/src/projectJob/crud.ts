import type { DB } from "@sproutos/db"
import type { Insertable, Kysely, Selectable, Updateable } from "kysely"
import { v7 } from "uuid"
import type { PartialBy } from "../utils/types"

export type ProjectJobKind = "provision" | "fork" | "sync_upstream" | "delete"

export type ProjectJobStep = {
  key: string
  label: string
  state: "pending" | "running" | "succeeded" | "failed" | "skipped"
}

/**
 * The step lists a client polls against.
 *
 * They are written at enqueue time rather than accumulated by the runner so the UI has something
 * to render in the second between "create" returning and the worker picking the job up — an empty
 * progress list reads as a stuck job.
 */
export const PROJECT_JOB_STEPS: Record<ProjectJobKind, readonly Omit<ProjectJobStep, "state">[]> = {
  fork: [
    { key: "fork_repository", label: "Forking the upstream repository" },
    { key: "link_installation", label: "Linking the GitHub App installation" },
    { key: "detect_settings", label: "Detecting build settings" },
    { key: "first_deploy", label: "Running the first deploy" },
  ],
  provision: [
    { key: "create_repository", label: "Creating the repository" },
    { key: "link_installation", label: "Linking the GitHub App installation" },
    { key: "detect_settings", label: "Detecting build settings" },
    { key: "first_deploy", label: "Running the first deploy" },
  ],
  sync_upstream: [
    { key: "compare_upstream", label: "Comparing against upstream" },
    { key: "open_pull_request", label: "Opening a pull request" },
  ],
  delete: [
    { key: "teardown_compute", label: "Tearing down services" },
    { key: "teardown_data", label: "Releasing databases, caches, and indexes" },
    { key: "mark_deleted", label: "Marking child records deleted" },
  ],
}

export function initialSteps(kind: ProjectJobKind): ProjectJobStep[] {
  return PROJECT_JOB_STEPS[kind].map((step) => ({ ...step, state: "pending" }))
}

export function crudProjectJob(db: Kysely<DB>) {
  async function create(
    data: PartialBy<Insertable<DB["projectJob"]>, "id">,
  ): Promise<Selectable<DB["projectJob"]>> {
    return await db
      .insertInto("projectJob")
      .values({ id: v7(), ...data })
      .returningAll()
      .executeTakeFirstOrThrow()
  }

  /**
   * Enqueues a job, or returns the one already queued under the same idempotency key.
   *
   * A repeated fork click is the common case, and the expensive half of it happens on GitHub. The
   * unique index on `idempotency_key` is what makes the second click a no-op rather than a second
   * repository.
   */
  async function enqueueOnce(
    data: PartialBy<Insertable<DB["projectJob"]>, "id">,
  ): Promise<Selectable<DB["projectJob"]> | undefined> {
    return await db
      .insertInto("projectJob")
      .values({ id: v7(), ...data })
      .onConflict((oc) => oc.column("idempotencyKey").doNothing())
      .returningAll()
      .executeTakeFirst()
  }

  async function update(
    id: string,
    data: Updateable<DB["projectJob"]>,
  ): Promise<Selectable<DB["projectJob"]> | undefined> {
    return await db
      .updateTable("projectJob")
      .set({ ...data, updatedAt: new Date() })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst()
  }

  return { create, enqueueOnce, update }
}
