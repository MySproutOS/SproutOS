import { crudUser, type PreparedProjectTeardown } from "@lib/dao"
import { tearDownProject } from "./teardown"
import type { JobHandler } from "./worker"

export const ACCOUNT_TEARDOWN_KIND = "account.teardown"

/** Remove every provider resource before anonymising the account that owned it. */
export function accountTeardown(projectTeardown: JobHandler = tearDownProject()): JobHandler {
  return async (job, context) => {
    const payload = job.payload as { userId?: unknown; projects?: unknown }
    if (typeof payload.userId !== "string" || !Array.isArray(payload.projects)) {
      throw new Error("account.teardown needs a userId and projects")
    }

    const projects = payload.projects as PreparedProjectTeardown[]
    for (const project of projects) {
      if (typeof project.projectId !== "string" || typeof project.projectJobId !== "string") {
        throw new Error("account.teardown received an invalid project teardown")
      }
      await projectTeardown(
        {
          ...job,
          payload: { projectId: project.projectId, projectJobId: project.projectJobId },
        },
        context,
      )
    }

    const deleted = await crudUser(context.db).completeUserDeletion(payload.userId)
    if (!deleted.ok) {
      if (deleted.reason === "owns_organizations") {
        throw new Error(
          `Account still owns active organizations: ${deleted.organizations.map(({ slug }) => slug).join(", ")}`,
        )
      }
      return
    }
  }
}

export const tearDownAccount = accountTeardown()
