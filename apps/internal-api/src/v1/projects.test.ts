/* oxlint-disable no-await-in-loop */
import { db } from "@sproutos/db"
import { sql } from "kysely"
import { v7 } from "uuid"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import app from "../index"
import {
  authHeaders,
  cleanupFixtures,
  createTestUser,
  databaseReachable,
  type TestUser,
  trackOrganization,
} from "../test/fixtures"
import { openEnvVarValue } from "./project-env"

const reachable = await databaseReachable()

/**
 * The envelope tests need the LocalStack KMS that `docker compose up` provides. They are skipped
 * rather than mocked when it is absent: a fake KMS would prove that the fake round-trips.
 */
async function kmsReachable(): Promise<boolean> {
  if (process.env.KMS_KEY_ID === undefined) return false
  try {
    const endpoint = process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566"
    const response = await fetch(`${endpoint}/_localstack/health`, {
      signal: AbortSignal.timeout(1500),
    })
    return response.ok
  } catch {
    return false
  }
}

const kmsUp = await kmsReachable()

type Json = Record<string, unknown>

async function call(
  method: string,
  path: string,
  user: TestUser | null,
  body?: unknown,
): Promise<{ status: number; json: Json }> {
  const response = await app.request(path, {
    method,
    headers: user === null ? { "Content-Type": "application/json" } : authHeaders(user),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

  const text = await response.text()
  return { status: response.status, json: text === "" ? {} : (JSON.parse(text) as Json) }
}

async function seedAgentCredential(organizationId: string, kind: string): Promise<string> {
  const id = v7()
  await db
    .insertInto("agentCredential")
    .values({
      id,
      organizationId,
      kind,
      label: `${kind}-${id.slice(-8)}`,
      secretCiphertext: "not-a-real-ciphertext",
      secretWrappedDek: "not-a-real-dek",
      secretKmsKeyId: "alias/test",
    })
    .execute()
  return id
}

describe.skipIf(!reachable)("project routes", () => {
  let alice: TestUser
  let bob: TestUser
  let carol: TestUser

  let orgA: string
  let orgAId: string
  let orgB: string
  let orgBId: string

  const listingId = v7()
  const listingSlug = `proj-test-listing-${listingId.slice(-8)}`

  let forkedProjectId = ""
  let sharedProjectId = ""
  let repositoryId = ""
  const usageEventIds: string[] = []

  beforeAll(async () => {
    alice = await createTestUser("projalice")
    bob = await createTestUser("projbob")
    carol = await createTestUser("projcarol")

    const a = await call("POST", "/v1/orgs", alice, { name: "Project Suite A" })
    const b = await call("POST", "/v1/orgs", bob, { name: "Project Suite B" })
    if (a.status !== 201 || b.status !== 201) {
      throw new Error("fixture setup failed: could not create the two organizations")
    }

    orgAId = trackOrganization(a.json.id as string)
    orgA = a.json.slug as string
    orgBId = trackOrganization(b.json.id as string)
    orgB = b.json.slug as string

    await db
      .insertInto("storeListing")
      .values({
        id: listingId,
        slug: listingSlug,
        name: "Forkable Fixture",
        tagline: "Something to fork",
        descriptionMd: "A published listing the project suite forks.",
        upstreamOwner: "example",
        upstreamRepo: `forkable-${listingId.slice(-8)}`,
        upstreamRepoUrl: `https://github.com/example/forkable-${listingId.slice(-8)}`,
        defaultBranch: "main",
        platform: "web",
        status: "published",
      })
      .execute()
  })

  afterAll(async () => {
    // `usage_event.project_id` and `.organization_id` are both ON DELETE RESTRICT, which is the
    // property the soft-delete test asserts — so the suite has to clear its own ledger rows
    // before the shared teardown can reach the organizations.
    if (usageEventIds.length > 0) {
      await db.deleteFrom("usageEvent").where("id", "in", usageEventIds).execute()
    }
    await db.deleteFrom("storeListing").where("id", "=", listingId).execute()
    await cleanupFixtures()
  })

  describe("creating a project", () => {
    it("forks a store listing through the one project entry point", async () => {
      const response = await call("POST", `/v1/orgs/${orgA}/projects`, alice, {
        name: "Forked Fixture",
        source: { type: "store", storeListingId: listingId, ownerLogin: "acme-test" },
      })

      expect(response.status).toBe(201)

      const project = response.json.project as Json
      const job = response.json.job as Json

      forkedProjectId = project.id as string
      repositoryId = project.repositoryId as string

      expect(project.slug).toBe("forked-fixture")
      expect(project.state).toBe("creating")
      expect(project.storeListingId).toBe(listingId)
      expect(project.repositoryProvenance).toBe("fork")

      expect(job.kind).toBe("fork")
      expect(job.state).toBe("queued")
      expect((job.steps as unknown[]).length).toBeGreaterThan(0)
    })

    /**
     * The row exists before GitHub has been asked for anything, so `repository.github_repo_id`
     * cannot hold the real id yet. It holds a negative placeholder derived from the row's own
     * UUID — GitHub ids are always positive — and the API reports `pendingCreation` rather than
     * inventing a number.
     */
    it("marks the repository as not yet created upstream", async () => {
      const response = await call("GET", `/v1/orgs/${orgA}/projects/${forkedProjectId}`, alice)
      expect(response.status).toBe(200)

      const repository = response.json.repository as Json
      expect(repository.pendingCreation).toBe(true)
      expect(repository.githubRepoId).toBeNull()
      expect(repository.liveProjectCount).toBe(1)

      const row = await db
        .selectFrom("repository")
        .select(["githubRepoId"])
        .where("id", "=", repositoryId)
        .executeTakeFirstOrThrow()

      expect(BigInt(row.githubRepoId)).toBeLessThan(0n)
    })

    it("counts the fork against the listing and records the event", async () => {
      const listing = await db
        .selectFrom("storeListing")
        .select(["installCount"])
        .where("id", "=", listingId)
        .executeTakeFirstOrThrow()

      expect(listing.installCount).toBe(1)

      const event = await db
        .selectFrom("storeListingEvent")
        .select(["kind", "userId"])
        .where("storeListingId", "=", listingId)
        .where("kind", "=", "fork_started")
        .executeTakeFirstOrThrow()

      expect(event.userId).toBe(alice.id)
    })

    it("exposes the job for polling and 404s a job from another project", async () => {
      const jobs = await call("GET", `/v1/orgs/${orgA}/projects/${forkedProjectId}/jobs`, alice)
      expect(jobs.status).toBe(200)

      const jobId = (jobs.json.data as Json[])[0].id as string
      const polled = await call(
        "GET",
        `/v1/orgs/${orgA}/projects/${forkedProjectId}/jobs/${jobId}`,
        alice,
      )
      expect(polled.status).toBe(200)
      expect(polled.json.state).toBe("queued")

      const bogus = await call(
        "GET",
        `/v1/orgs/${orgA}/projects/${forkedProjectId}/jobs/${v7()}`,
        alice,
      )
      expect(bogus.status).toBe(404)
    })

    it("refuses to fork a listing that is not published", async () => {
      const draftId = v7()
      await db
        .insertInto("storeListing")
        .values({
          id: draftId,
          slug: `proj-test-draft-${draftId.slice(-8)}`,
          name: "Draft",
          tagline: "Not reviewed",
          descriptionMd: "x",
          upstreamOwner: "example",
          upstreamRepo: `draft-${draftId.slice(-8)}`,
          upstreamRepoUrl: `https://github.com/example/draft-${draftId.slice(-8)}`,
          status: "draft",
        })
        .execute()

      const response = await call("POST", `/v1/orgs/${orgA}/projects`, alice, {
        name: "Should Not Exist",
        source: { type: "store", storeListingId: draftId, ownerLogin: "acme-test" },
      })

      expect(response.status).toBe(400)
      await db.deleteFrom("storeListing").where("id", "=", draftId).execute()
    })

    /**
     * No installation and no `ownerLogin` is not a 500 — there is nowhere to put the repository,
     * and the message says which of the two fixes it.
     */
    it("explains what is missing when there is no GitHub account to create into", async () => {
      const response = await call("POST", `/v1/orgs/${orgA}/projects`, alice, {
        name: "Nowhere To Put It",
        source: { type: "blank" },
      })

      expect(response.status).toBe(400)
      expect(JSON.stringify(response.json)).toContain("GitHub App")
    })
  })

  /**
   * TASK 21. Two projects, one repository, differing by directory or branch. Upkeep runs per
   * repository; deploys run per project.
   */
  describe("a repository shared by two projects", () => {
    it("creates a second project on the same repository at a different directory", async () => {
      const response = await call("POST", `/v1/orgs/${orgA}/projects`, alice, {
        name: "Admin Surface",
        rootDir: "apps/admin",
        source: { type: "repository", repositoryId },
      })

      expect(response.status).toBe(201)

      const project = response.json.project as Json
      sharedProjectId = project.id as string

      expect(project.repositoryId).toBe(repositoryId)
      expect(project.rootDir).toBe("apps/admin")
      expect((response.json.job as Json).kind).toBe("provision")
    })

    it("writes no second repository row for the shared repository", async () => {
      const rows = await db
        .selectFrom("repository")
        .select(["id"])
        .where("organizationId", "=", orgAId)
        .where("deletedAt", "is", null)
        .execute()

      expect(rows.map((row) => row.id)).toStrictEqual([repositoryId])
    })

    it("reports both projects against the one repository", async () => {
      const response = await call("GET", `/v1/orgs/${orgA}/projects/${sharedProjectId}`, alice)
      expect(response.status).toBe(200)
      expect((response.json.repository as Json).liveProjectCount).toBe(2)

      const filtered = await call(
        "GET",
        `/v1/orgs/${orgA}/projects?repositoryId=${repositoryId}`,
        alice,
      )
      const ids = (filtered.json.data as Json[]).map((row) => row.id)
      expect(ids).toHaveLength(2)
      expect(ids).toContain(forkedProjectId)
      expect(ids).toContain(sharedProjectId)
    })

    /**
     * The partial unique index on `(organization_id, repository_id, root_dir, production_branch)`
     * is the authority. The route checks first so the answer is a 409 with a sentence rather than
     * a constraint violation surfacing as a 500.
     */
    it("refuses a third project on the same repository, directory, and branch", async () => {
      const response = await call("POST", `/v1/orgs/${orgA}/projects`, alice, {
        name: "Duplicate Target",
        rootDir: "apps/admin",
        source: { type: "repository", repositoryId },
      })

      expect(response.status).toBe(409)
      expect(JSON.stringify(response.json)).toContain("apps/admin")
    })

    it("allows the same directory on a different branch", async () => {
      const response = await call("POST", `/v1/orgs/${orgA}/projects`, alice, {
        name: "Admin Staging",
        rootDir: "apps/admin",
        productionBranch: "staging",
        source: { type: "repository", repositoryId },
      })

      expect(response.status).toBe(201)

      const created = (response.json.project as Json).id as string
      await call("DELETE", `/v1/orgs/${orgA}/projects/${created}`, alice)
    })
  })

  describe("cross-organization isolation", () => {
    it("does not list another organization's projects", async () => {
      const response = await call("GET", `/v1/orgs/${orgB}/projects`, bob)
      expect(response.status).toBe(200)
      expect(response.json.data).toStrictEqual([])
    })

    /**
     * `requirePermission` builds its SRN from the resolved organization and a path parameter it
     * does not verify, so this id authorizes cleanly inside org B. The only thing that stops the
     * read is the DAO's `organization_id` predicate.
     */
    it("404s another organization's project id under the caller's own organization", async () => {
      const response = await call("GET", `/v1/orgs/${orgB}/projects/${forkedProjectId}`, bob)
      expect(response.status).toBe(404)
    })

    it("404s the same id under the owning organization, because the caller is not a member", async () => {
      const response = await call("GET", `/v1/orgs/${orgA}/projects/${forkedProjectId}`, bob)
      expect(response.status).toBe(404)
    })

    it("refuses every mutating route across the boundary", async () => {
      const attempts: [string, string][] = [
        ["PATCH", `/v1/orgs/${orgA}/projects/${forkedProjectId}`],
        ["DELETE", `/v1/orgs/${orgA}/projects/${forkedProjectId}`],
        ["PUT", `/v1/orgs/${orgA}/projects/${forkedProjectId}/env`],
      ]

      for (const [method, path] of attempts) {
        const response = await call(method, path, bob, {
          name: "Hijacked",
          key: "HIJACK",
          value: "x",
        })
        expect(response.status).toBe(404)
      }
    })

    it("keeps another organization's repositories out of the repository list", async () => {
      const response = await call("GET", `/v1/orgs/${orgB}/repositories`, bob)
      expect(response.status).toBe(200)
      expect(response.json.data).toStrictEqual([])

      const own = await call("GET", `/v1/orgs/${orgA}/repositories`, alice)
      expect((own.json.data as Json[]).map((row) => row.id)).toStrictEqual([repositoryId])

      const rows = await db
        .selectFrom("project")
        .select(["id"])
        .where("organizationId", "=", orgBId)
        .execute()
      expect(rows).toStrictEqual([])
    })

    it("gives a plain member 403 on the actions the member role does not carry", async () => {
      const roles = (await call("GET", `/v1/orgs/${orgA}/roles`, alice)).json.data as {
        id: string
        name: string
      }[]
      const memberRoleId = roles.find((role) => role.name === "member")?.id

      const invite = await call("POST", `/v1/orgs/${orgA}/invites`, alice, {
        email: carol.email,
        roleId: memberRoleId,
      })
      expect(invite.status).toBe(201)

      const accepted = await call("POST", "/v1/invites/accept", carol, {
        token: invite.json.token,
      })
      expect(accepted.status).toBe(200)

      const read = await call("GET", `/v1/orgs/${orgA}/projects/${forkedProjectId}`, carol)
      expect(read.status).toBe(200)

      const write = await call("PUT", `/v1/orgs/${orgA}/projects/${forkedProjectId}/env`, carol, {
        key: "NOT_ALLOWED",
        value: "x",
      })
      expect(write.status).toBe(403)

      const destroy = await call("DELETE", `/v1/orgs/${orgA}/projects/${forkedProjectId}`, carol)
      expect(destroy.status).toBe(403)
    })
  })

  describe.skipIf(!kmsUp)("environment variables", () => {
    let envVarId = ""
    const secret = "postgres://user:hunter2@db.internal:5432/app"

    it("stores a value envelope-encrypted and returns no plaintext", async () => {
      const response = await call(
        "PUT",
        `/v1/orgs/${orgA}/projects/${forkedProjectId}/env`,
        alice,
        {
          key: "DATABASE_URL",
          value: secret,
          target: "production",
        },
      )

      expect(response.status).toBe(200)
      envVarId = response.json.id as string
      expect(response.json.key).toBe("DATABASE_URL")
      expect(JSON.stringify(response.json)).not.toContain("hunter2")

      const row = await db
        .selectFrom("projectEnvVar")
        .select(["valueCiphertext", "valueWrappedDek", "valueKmsKeyId"])
        .where("id", "=", envVarId)
        .executeTakeFirstOrThrow()

      expect(row.valueCiphertext).not.toContain("hunter2")
      expect(row.valueCiphertext).not.toBe(secret)
      expect(row.valueWrappedDek.length).toBeGreaterThan(0)
      expect(row.valueKmsKeyId.length).toBeGreaterThan(0)
    })

    it("never returns a value from the list route", async () => {
      const response = await call("GET", `/v1/orgs/${orgA}/projects/${forkedProjectId}/env`, alice)
      expect(response.status).toBe(200)

      const body = JSON.stringify(response.json)
      expect(body).not.toContain("hunter2")
      expect(body).not.toContain("valueCiphertext")
      expect(body).not.toContain("valueWrappedDek")

      const rows = response.json.data as Json[]
      expect(rows).toHaveLength(1)
      expect(rows[0].key).toBe("DATABASE_URL")
      expect(rows[0].isSecret).toBe(true)
    })

    it("round-trips the value through the explicit reveal action, and audits it", async () => {
      const response = await call(
        "POST",
        `/v1/orgs/${orgA}/projects/${forkedProjectId}/env/${envVarId}/reveal`,
        alice,
      )

      expect(response.status).toBe(200)
      expect(response.json.value).toBe(secret)

      const audit = await db
        .selectFrom("auditLog")
        .select(["action", "resourceSrn", "after"])
        .where("organizationId", "=", orgAId)
        .where("action", "=", "credential:read")
        .executeTakeFirstOrThrow()

      expect(audit.resourceSrn).toContain(envVarId)
      expect(JSON.stringify(audit.after)).not.toContain("hunter2")
    })

    /**
     * The encryption context binds the project id and the key name. Lifting a ciphertext onto a
     * different key inside the same project has to fail, not silently yield the wrong secret.
     */
    it("refuses to open a ciphertext under a different key name", async () => {
      const row = await db
        .selectFrom("projectEnvVar")
        .select(["valueCiphertext", "valueWrappedDek", "valueKmsKeyId"])
        .where("id", "=", envVarId)
        .executeTakeFirstOrThrow()

      const sealed = {
        ciphertext: row.valueCiphertext,
        kmsKeyId: row.valueKmsKeyId,
        wrappedDek: row.valueWrappedDek,
      }

      await expect(openEnvVarValue(forkedProjectId, "DATABASE_URL", sealed)).resolves.toBe(secret)
      await expect(openEnvVarValue(forkedProjectId, "STRIPE_KEY", sealed)).rejects.toThrow(
        /Decryption failed/,
      )
      await expect(openEnvVarValue(sharedProjectId, "DATABASE_URL", sealed)).rejects.toThrow(
        /Decryption failed/,
      )
    })

    it("re-seals on update rather than keeping the old ciphertext", async () => {
      const before = await db
        .selectFrom("projectEnvVar")
        .select(["valueCiphertext"])
        .where("id", "=", envVarId)
        .executeTakeFirstOrThrow()

      const response = await call(
        "PUT",
        `/v1/orgs/${orgA}/projects/${forkedProjectId}/env`,
        alice,
        {
          key: "DATABASE_URL",
          value: "postgres://user:rotated@db.internal:5432/app",
          target: "production",
        },
      )
      expect(response.status).toBe(200)
      expect(response.json.id).toBe(envVarId)

      const after = await db
        .selectFrom("projectEnvVar")
        .select(["valueCiphertext"])
        .where("id", "=", envVarId)
        .executeTakeFirstOrThrow()

      expect(after.valueCiphertext).not.toBe(before.valueCiphertext)

      const revealed = await call(
        "POST",
        `/v1/orgs/${orgA}/projects/${forkedProjectId}/env/${envVarId}/reveal`,
        alice,
      )
      expect(revealed.json.value).toBe("postgres://user:rotated@db.internal:5432/app")
    })

    it("rejects a key that is not a valid environment variable name", async () => {
      const response = await call(
        "PUT",
        `/v1/orgs/${orgA}/projects/${forkedProjectId}/env`,
        alice,
        {
          key: "not-a-valid-name",
          value: "x",
        },
      )
      expect(response.status).toBe(400)
    })

    it("removes a variable outright rather than soft-deleting a live secret", async () => {
      const created = await call("PUT", `/v1/orgs/${orgA}/projects/${forkedProjectId}/env`, alice, {
        key: "TEMPORARY",
        value: "delete-me",
      })
      const id = created.json.id as string

      const removed = await call(
        "DELETE",
        `/v1/orgs/${orgA}/projects/${forkedProjectId}/env/${id}`,
        alice,
      )
      expect(removed.status).toBe(200)

      const row = await db
        .selectFrom("projectEnvVar")
        .select(["id"])
        .where("id", "=", id)
        .executeTakeFirst()

      expect(row).toBeUndefined()
    })
  })

  /**
   * TASK 17. `auto_update_enabled` keys on the resolved credential kind: a Claude subscription is
   * flat-rate, so nightly upkeep costs the customer nothing extra; any per-token API key would
   * spend money they never authorized.
   */
  describe("the auto-update default", () => {
    it("is off when the organization has no agent credential at all", async () => {
      const project = await call("GET", `/v1/orgs/${orgA}/projects/${forkedProjectId}`, alice)
      expect(project.json.autoUpdateEnabled).toBe(false)
      expect(project.json.agentCredentialId).toBeNull()
    })

    it("is on for a Claude subscription token", async () => {
      const credentialId = await seedAgentCredential(orgAId, "claude_subscription")

      const response = await call("POST", `/v1/orgs/${orgA}/projects`, alice, {
        name: "Subscription Default",
        rootDir: "apps/sub",
        source: { type: "repository", repositoryId },
      })

      expect(response.status).toBe(201)
      const project = response.json.project as Json
      expect(project.agentCredentialId).toBe(credentialId)
      expect(project.autoUpdateEnabled).toBe(true)

      await call("DELETE", `/v1/orgs/${orgA}/projects/${project.id as string}`, alice)
      await db.deleteFrom("agentCredential").where("id", "=", credentialId).execute()
    })

    it("is off for a plain API key", async () => {
      const credentialId = await seedAgentCredential(orgAId, "anthropic_api_key")

      const response = await call("POST", `/v1/orgs/${orgA}/projects`, alice, {
        name: "Api Key Default",
        rootDir: "apps/apikey",
        source: { type: "repository", repositoryId },
      })

      expect(response.status).toBe(201)
      const project = response.json.project as Json
      expect(project.agentCredentialId).toBe(credentialId)
      expect(project.autoUpdateEnabled).toBe(false)

      await call("DELETE", `/v1/orgs/${orgA}/projects/${project.id as string}`, alice)
      await db.deleteFrom("agentCredential").where("id", "=", credentialId).execute()
    })

    it("still honours an explicit choice", async () => {
      const credentialId = await seedAgentCredential(orgAId, "anthropic_api_key")

      const response = await call("POST", `/v1/orgs/${orgA}/projects`, alice, {
        name: "Explicit Choice",
        rootDir: "apps/explicit",
        autoUpdateEnabled: true,
        autoUpdateMode: "auto_merge",
        source: { type: "repository", repositoryId },
      })

      const project = response.json.project as Json
      expect(project.autoUpdateEnabled).toBe(true)
      expect(project.autoUpdateMode).toBe("auto_merge")

      await call("DELETE", `/v1/orgs/${orgA}/projects/${project.id as string}`, alice)
      await db.deleteFrom("agentCredential").where("id", "=", credentialId).execute()
    })
  })

  /**
   * One upkeep run against the repository fans out into one suggestion per project on that
   * repository and branch — which is only expressible because the two are separate entities.
   */
  describe("fork update suggestions", () => {
    let syncRunId = ""

    it("fans one sync run out into a suggestion per project on the repository", async () => {
      syncRunId = v7()
      await db
        .insertInto("upstreamSyncRun")
        .values({
          id: syncRunId,
          repositoryId,
          branch: "main",
          behindBy: 4,
          aheadBy: 1,
          outcome: "pr_opened",
          mergeType: "merge",
          pullRequestNumber: 12,
          pullRequestUrl: "https://github.com/acme-test/x/pull/12",
        })
        .execute()

      await db
        .insertInto("projectUpdateSuggestion")
        .values(
          [forkedProjectId, sharedProjectId].map((projectId) => ({
            id: v7(),
            projectId,
            upstreamSyncRunId: syncRunId,
            summary: "4 commits behind upstream",
            status: "pending",
          })),
        )
        .execute()

      for (const projectId of [forkedProjectId, sharedProjectId]) {
        const response = await call(
          "GET",
          `/v1/orgs/${orgA}/projects/${projectId}/update-suggestions`,
          alice,
        )
        expect(response.status).toBe(200)

        const rows = response.json.data as Json[]
        expect(rows).toHaveLength(1)
        expect(rows[0].behindBy).toBe(4)
        expect(rows[0].pullRequestNumber).toBe(12)
        expect(rows[0].upstreamSyncRunId).toBe(syncRunId)
      }
    })

    it("accepting one queues a sync job and does not resolve the other project's card", async () => {
      const list = await call(
        "GET",
        `/v1/orgs/${orgA}/projects/${forkedProjectId}/update-suggestions?status=pending`,
        alice,
      )
      const suggestionId = (list.json.data as Json[])[0].id as string

      const accepted = await call(
        "POST",
        `/v1/orgs/${orgA}/projects/${forkedProjectId}/update-suggestions/${suggestionId}/accept`,
        alice,
      )
      expect(accepted.status).toBe(200)
      expect(accepted.json.status).toBe("accepted")

      const job = await db
        .selectFrom("projectJob")
        .select(["kind", "repositoryId", "state"])
        .where("projectId", "=", forkedProjectId)
        .where("kind", "=", "sync_upstream")
        .executeTakeFirstOrThrow()

      expect(job.repositoryId).toBe(repositoryId)
      expect(job.state).toBe("queued")

      const other = await call(
        "GET",
        `/v1/orgs/${orgA}/projects/${sharedProjectId}/update-suggestions?status=pending`,
        alice,
      )
      expect(other.json.data as Json[]).toHaveLength(1)
    })

    it("is idempotent: a second accept finds nothing pending", async () => {
      const list = await call(
        "GET",
        `/v1/orgs/${orgA}/projects/${forkedProjectId}/update-suggestions`,
        alice,
      )
      const suggestionId = (list.json.data as Json[])[0].id as string

      const again = await call(
        "POST",
        `/v1/orgs/${orgA}/projects/${forkedProjectId}/update-suggestions/${suggestionId}/accept`,
        alice,
      )
      expect(again.status).toBe(404)
    })

    it("dismisses the other project's suggestion without touching the repository", async () => {
      const list = await call(
        "GET",
        `/v1/orgs/${orgA}/projects/${sharedProjectId}/update-suggestions?status=pending`,
        alice,
      )
      const suggestionId = (list.json.data as Json[])[0].id as string

      const dismissed = await call(
        "POST",
        `/v1/orgs/${orgA}/projects/${sharedProjectId}/update-suggestions/${suggestionId}/dismiss`,
        alice,
      )
      expect(dismissed.status).toBe(200)
      expect(dismissed.json.status).toBe("dismissed")

      const syncJobs = await db
        .selectFrom("projectJob")
        .select(["id"])
        .where("projectId", "=", sharedProjectId)
        .where("kind", "=", "sync_upstream")
        .execute()

      expect(syncJobs).toHaveLength(0)
    })
  })

  /**
   * ADR 0017. Deletion is a state change plus a teardown job. Nothing `usage_event` points at is
   * ever destroyed, because that is the record justifying charges already made.
   */
  describe("soft delete", () => {
    beforeAll(async () => {
      const id = v7()
      await db
        .insertInto("usageEvent")
        .values({
          id,
          organizationId: orgAId,
          projectId: forkedProjectId,
          resourceType: "site",
          dimension: "site_request",
          quantity: "1000",
          occurredAt: new Date(),
          source: "projects-test",
          externalId: `projects-test-${id}`,
        })
        .execute()
      usageEventIds.push(id)
    })

    it("keeps the repository while another project still uses it", async () => {
      const response = await call("DELETE", `/v1/orgs/${orgA}/projects/${sharedProjectId}`, alice)
      expect(response.status).toBe(200)
      expect(response.json.repositoryReleased).toBe(false)
      expect(response.json.remainingProjectsOnRepository).toBe(1)

      const repository = await db
        .selectFrom("repository")
        .select(["deletedAt"])
        .where("id", "=", repositoryId)
        .executeTakeFirstOrThrow()

      expect(repository.deletedAt).toBeNull()
    })

    it("says what was destroyed, what is queued, and what was kept", async () => {
      const response = await call("DELETE", `/v1/orgs/${orgA}/projects/${forkedProjectId}`, alice)
      expect(response.status).toBe(200)

      expect(response.json.destroyed).toStrictEqual([])
      expect(response.json.retained).toContain("usage_event")
      expect(response.json.scheduledForTeardown).toContain("deployment")
      expect(response.json.repositoryReleased).toBe(true)
      expect((response.json.project as Json).state).toBe("deleting")
      expect((response.json.project as Json).deletedAt).not.toBeNull()
      expect((response.json.job as Json).kind).toBe("delete")
      expect(response.json.message).toContain("billing history")
    })

    it("hides the project from every read path afterwards", async () => {
      const list = await call("GET", `/v1/orgs/${orgA}/projects`, alice)
      expect((list.json.data as Json[]).map((row) => row.id)).not.toContain(forkedProjectId)

      const read = await call("GET", `/v1/orgs/${orgA}/projects/${forkedProjectId}`, alice)
      expect(read.status).toBe(404)

      const second = await call("DELETE", `/v1/orgs/${orgA}/projects/${forkedProjectId}`, alice)
      expect(second.status).toBe(404)
    })

    it("keeps the usage row, still attributable to the deleted project by name", async () => {
      const row = await db
        .selectFrom("usageEvent")
        .innerJoin("project", "project.id", "usageEvent.projectId")
        .select([
          "usageEvent.quantity as quantity",
          "project.slug as slug",
          "project.deletedAt as deletedAt",
        ])
        .where("usageEvent.id", "=", usageEventIds[0])
        .executeTakeFirstOrThrow()

      expect(row.slug).toBe("forked-fixture")
      expect(row.deletedAt).not.toBeNull()
    })

    /**
     * The FK is what actually guarantees the above. A hard delete is refused by Postgres, which
     * is why deletion had to become a state change in the first place.
     */
    it("cannot be turned into a hard delete while the ledger still references it", async () => {
      await expect(
        sql`delete from project where id = ${forkedProjectId}`.execute(db),
      ).rejects.toThrow(/violates RESTRICT setting of foreign key constraint/)
    })
  })
})
