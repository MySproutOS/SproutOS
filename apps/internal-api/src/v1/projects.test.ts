import { openEnvVarValue } from "@lib/envelope"
/* oxlint-disable no-await-in-loop */
import { overhead, rateTimesQuantity } from "@lib/billing/money"
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
  const usageRollupIds: string[] = []

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
    // Billing grains are ON DELETE RESTRICT, which is the property the soft-delete test asserts —
    // so the suite has to clear its own rows before shared teardown reaches the organizations.
    if (usageRollupIds.length > 0) {
      await db.deleteFrom("usageRollup").where("id", "in", usageRollupIds).execute()
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

    it("records the attempt, and does not count it as an install", async () => {
      /*
        `install_count` used to move here, three lines after the job was queued and long before
        anything had been forked. It is the number every store card shows as "INSTALLS", and it was
        counting attempts: two failed forks of the same listing on the live deployment — both ending
        in `NoUsableCredentialError`, neither leaving a repository anywhere — read as two installs.

        It now moves in `runProvision`, behind a repository that exists. The event stays here,
        because `fork_started` is exactly what this is.
      */
      const listing = await db
        .selectFrom("storeListing")
        .select(["installCount"])
        .where("id", "=", listingId)
        .executeTakeFirstOrThrow()

      expect(listing.installCount).toBe(0)

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

    /*
      The picker's handle, not this platform's.

      `POST /projects` accepted only a `repository` row id, and the dashboard's picker lists what the
      *installation* can reach — entries that mostly have no row here. It sent GitHub's numeric id in
      the `repositoryId` field, which is validated as a UUID, so every request failed at the
      validator with a message about a malformed id. The third way of starting a project was
      unreachable from the interface built for it, and nothing failed loudly enough to say so.
    */
    it("accepts GitHub's own repository id and resolves it to the existing row", async () => {
      /*
        The fixture, briefly given an id GitHub would have assigned.

        It is still a placeholder otherwise — `createPending` writes the negative half of the range
        until GitHub answers — and a placeholder is correctly refused here, because there is nothing
        on GitHub to start a project from yet. Borrowing the row rather than adding one keeps the
        organization's repository count what the surrounding tests assert it to be.
      */
      const original = await db
        .selectFrom("repository")
        .select(["githubRepoId"])
        .where("id", "=", repositoryId)
        .executeTakeFirstOrThrow()

      const githubRepoId = "880123456"
      await db
        .updateTable("repository")
        .set({ githubRepoId })
        .where("id", "=", repositoryId)
        .execute()

      let createdProjectId: string | undefined

      try {
        const response = await call("POST", `/v1/orgs/${orgA}/projects`, alice, {
          name: "By GitHub Id",
          rootDir: "apps/byid",
          source: { type: "repository", githubRepoId },
        })

        expect(response.status).toBe(201)

        const project = response.json.project as Json
        createdProjectId = project.id as string
        expect(project.repositoryId).toBe(repositoryId)
      } finally {
        /*
          Put back exactly what was borrowed.

          The surrounding tests count projects on this repository and repositories in this
          organization, so a project left behind here fails three of them somewhere further down —
          in assertions that say nothing about GitHub ids and give no hint where the extra row came
          from.
        */
        if (createdProjectId !== undefined) {
          await db.deleteFrom("projectJob").where("projectId", "=", createdProjectId).execute()
          await db.deleteFrom("project").where("id", "=", createdProjectId).execute()
        }

        await db
          .updateTable("repository")
          .set({ githubRepoId: original.githubRepoId })
          .where("id", "=", repositoryId)
          .execute()
      }
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
      /*
        Three rows, not two: both projects and the group they live in.

        A repository starts as a group and its projects go inside it, so a listing filtered to one
        repository shows the container as well as its contents — which is what the switcher and the
        group page render. `liveProjectCount` above stays 2 because that number answers a different
        question: how many *deployable* projects use this repository, which decides whether deleting
        one releases it.
      */
      const rows = filtered.json.data as Json[]
      const ids = rows.map((row) => row.id)
      expect(ids).toHaveLength(3)
      expect(ids).toContain(forkedProjectId)
      expect(ids).toContain(sharedProjectId)
      expect(rows.filter((row) => row.isGroup === true)).toHaveLength(1)
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

  describe.skipIf(!kmsUp)("config files", () => {
    /*
      The routes that let a forked project have a config file at all.

      `glance` — forked, built, pushed and deployed by this platform — exited with
      `reading /app/config/glance.yml: no such file or directory`. Most self-hostable software is
      configured by a file and reads nothing from the environment, so without these the store is
      limited to the projects that happen to be fully env-configurable.

      Mirrors the environment-variable suite below, because the routes deliberately mirror those.
    */
    let fileId = ""
    const contents = "pages:\n  - name: Home\n    api-key: hunter2\n"

    it("stores contents envelope-encrypted and returns no plaintext", async () => {
      const response = await call(
        "PUT",
        `/v1/orgs/${orgA}/projects/${forkedProjectId}/files`,
        alice,
        { path: "/app/config/glance.yml", contents, target: "production" },
      )

      expect(response.status).toBe(200)
      fileId = response.json.id as string
      expect(response.json.path).toBe("/app/config/glance.yml")
      // A config file is a mixture by nature — layout next to API keys — so the whole thing is
      // sealed and the response carries none of it.
      expect(JSON.stringify(response.json)).not.toContain("hunter2")

      const row = await db
        .selectFrom("projectFile")
        .select(["contentsCiphertext", "contentsWrappedDek", "contentsKmsKeyId"])
        .where("id", "=", fileId)
        .executeTakeFirstOrThrow()

      expect(row.contentsCiphertext).not.toContain("hunter2")
      expect(row.contentsWrappedDek.length).toBeGreaterThan(0)
      expect(row.contentsKmsKeyId.length).toBeGreaterThan(0)
    })

    it("lists files without their contents", async () => {
      const response = await call(
        "GET",
        `/v1/orgs/${orgA}/projects/${forkedProjectId}/files`,
        alice,
      )

      expect(response.status).toBe(200)
      expect(JSON.stringify(response.json)).not.toContain("hunter2")
      expect((response.json.data as Json[]).map((row) => row.path)).toContain(
        "/app/config/glance.yml",
      )
    })

    it("reveals the contents through a route named after what it does", async () => {
      const response = await call(
        "POST",
        `/v1/orgs/${orgA}/projects/${forkedProjectId}/files/${fileId}/reveal`,
        alice,
      )

      expect(response.status).toBe(200)
      expect(response.json.contents).toBe(contents)
    })

    it("writes the reveal to the audit log without the contents", async () => {
      // A reveal that is not in `audit_log` is a secret read nobody can account for later — and
      // `before`/`after` are jsonb on an append-only table, so contents there could never be
      // deleted.
      const rows = await db
        .selectFrom("auditLog")
        .select(["action", "after"])
        .where("organizationId", "=", orgAId)
        .where("action", "=", "credential:read")
        .execute()

      const entries = JSON.stringify(rows)
      expect(entries).toContain("/app/config/glance.yml")
      expect(entries).not.toContain("hunter2")
    })

    it("upserts rather than duplicating the same path", async () => {
      // Editing a config file is the common case, and `(project_id, path, target)` is unique.
      const again = await call("PUT", `/v1/orgs/${orgA}/projects/${forkedProjectId}/files`, alice, {
        path: "/app/config/glance.yml",
        contents: "pages: []\n",
        target: "production",
      })

      expect(again.status).toBe(200)
      expect(again.json.id).toBe(fileId)
    })

    it("refuses a path that cannot be mounted", async () => {
      /*
        Refused at the edge rather than at the kubelet. A `subPath` containing `..` fails the pod
        with a message about the volume, and a relative path has no anchor inside the container —
        both arrive as a broken deployment rather than as a rejected request.
      */
      for (const path of ["app/config.yml", "/app/../etc/passwd", "/app/", "/"]) {
        const response = await call(
          "PUT",
          `/v1/orgs/${orgA}/projects/${forkedProjectId}/files`,
          alice,
          { path, contents: "x" },
        )
        expect(response.status).toBe(400)
      }
    })

    it("removes a file", async () => {
      const response = await call(
        "DELETE",
        `/v1/orgs/${orgA}/projects/${forkedProjectId}/files/${fileId}`,
        alice,
      )
      expect(response.status).toBe(200)

      const row = await db
        .selectFrom("projectFile")
        .select("id")
        .where("id", "=", fileId)
        .executeTakeFirst()
      // Hard delete: the row holds decryptable contents, and the request was to stop holding them.
      expect(row).toBeUndefined()
    })

    it("keeps another organization out", async () => {
      const response = await call("GET", `/v1/orgs/${orgA}/projects/${forkedProjectId}/files`, bob)
      expect(response.status).toBe(404)
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
        // Narrowed to *this* variable's row. It used to take whichever row came back first, which
        // held only while env vars were the sole thing anyone could reveal — adding config-file
        // reveals broke it, and the assertion was never about "the first audit row" anyway.
        .where("resourceSrn", "like", `%${envVarId}%`)
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
   * ADR 0017. Deletion is a state change plus a teardown job. Nothing a billing grain points at is
   * destroyed, because that is the record justifying charges already made.
   */
  describe("soft delete", () => {
    beforeAll(async () => {
      const id = v7()
      await db
        .insertInto("usageRollup")
        .values({
          id,
          organizationId: orgAId,
          projectId: forkedProjectId,
          dimension: "site_request",
          quantity: "1000",
          bucket: "day",
          bucketStart: new Date(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z"),
        })
        .execute()
      usageRollupIds.push(id)
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
      expect(response.json.retained).toContain("usage_rollup")
      expect(response.json.retained).not.toContain("usage_event")
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

    it("keeps the billing grain attributable to the deleted project by name", async () => {
      const row = await db
        .selectFrom("usageRollup")
        .innerJoin("project", "project.id", "usageRollup.projectId")
        .select([
          "usageRollup.quantity as quantity",
          "project.slug as slug",
          "project.deletedAt as deletedAt",
        ])
        .where("usageRollup.id", "=", usageRollupIds[0])
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

  describe("what the project list shows", () => {
    /**
     * A project of this suite's own, on a repository of its own.
     *
     * Not the shared `repositoryId` an earlier block sets: that one is created by a route that
     * needs GitHub, which is not configured here, so depending on it makes these tests fail for a
     * reason that has nothing to do with what they assert.
     */
    async function ownProject(name: string): Promise<{ id: string; repositoryId: string }> {
      const repository = v7()
      await db
        .insertInto("repository")
        .values({
          id: repository,
          organizationId: orgAId,
          githubRepoId: BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000)),
          ownerLogin: "acme-test",
          name: `list-${repository}`,
          provenance: "new",
        })
        .execute()

      const created = await call("POST", `/v1/orgs/${orgA}/projects`, alice, {
        name,
        source: { type: "repository", repositoryId: repository },
      })
      expect(created.status).toBe(201)
      return { id: (created.json.project as Json).id as string, repositoryId: repository }
    }
    it("reports zero cost for a project with no metered usage", async () => {
      const { id: projectId } = await ownProject("Unmetered")

      const list = await call("GET", `/v1/orgs/${orgA}/projects`, alice)
      const entry = (list.json.data as Array<Record<string, unknown>>).find(
        (project) => project.id === projectId,
      )

      /*
        Zero, not absent and not null. Nothing has been recorded against this project, which is a
        real answer — a project that has not run has not cost anything. A null here would make the
        UI show a dash where a customer expects a number.
      */
      expect(entry?.costMicroUsd).toBe("0")
      // A string, not a number: micro-USD is bigint, and JSON has no integer wide enough to trust.
      expect(typeof entry?.costMicroUsd).toBe("string")
    })

    it("rates metered usage against the price book", async () => {
      const { id: projectId } = await ownProject("Metered")

      const item = await db
        .selectFrom("priceBookItem")
        .innerJoin("priceBook", "priceBook.id", "priceBookItem.priceBookId")
        .select(["priceBookItem.dimension", "priceBookItem.unitMicroUsd", "priceBook.overheadBps"])
        .where("priceBookItem.dimension", "=", "site_request")
        .orderBy("priceBook.effectiveAt", "desc")
        .executeTakeFirstOrThrow()

      const rollupId = v7()
      await db
        .insertInto("usageRollup")
        .values({
          id: rollupId,
          organizationId: orgAId,
          projectId,
          dimension: item.dimension,
          bucket: "day",
          bucketStart: new Date(),
          quantity: "1000",
        })
        .execute()

      const list = await call("GET", `/v1/orgs/${orgA}/projects`, alice)
      const entry = (list.json.data as Array<Record<string, unknown>>).find(
        (project) => project.id === projectId,
      )

      const expectedUsage = rateTimesQuantity(String(item.unitMicroUsd), "1000")
      const expected = expectedUsage + overhead(expectedUsage, item.overheadBps)
      expect(entry?.costMicroUsd).toBe(expected.toString())

      // The overhead is a real part of the number, not a rounding artefact — a statement has to be
      // explicable as usage plus overhead.
      expect(BigInt(entry?.costMicroUsd as string)).toBeGreaterThan(expectedUsage)

      await db.deleteFrom("usageRollup").where("id", "=", rollupId).execute()
    })

    it("counts each rollup grain once", async () => {
      /*
        The same usage is rolled up at minute, hour *and* day grain. Summing across buckets would
        bill everything three times, which is the kind of bug a customer notices before we do.
      */
      const { id: projectId } = await ownProject("Triple")

      const item = await db
        .selectFrom("priceBookItem")
        .select(["dimension"])
        .executeTakeFirstOrThrow()

      const ids: string[] = []
      for (const bucket of ["minute", "hour", "day"] as const) {
        const id = v7()
        ids.push(id)
        await db
          .insertInto("usageRollup")
          .values({
            id,
            organizationId: orgAId,
            projectId,
            dimension: item.dimension,
            bucket,
            bucketStart: new Date(),
            quantity: "100",
          })
          .execute()
      }

      const withAll = await call("GET", `/v1/orgs/${orgA}/projects`, alice)
      const withAllCost = BigInt(
        ((withAll.json.data as Array<Record<string, unknown>>).find(
          (project) => project.id === projectId,
        )?.costMicroUsd ?? "0") as string,
      )

      // Now the day grain alone, which is what the query is supposed to have used all along.
      await db.deleteFrom("usageRollup").where("id", "in", ids.slice(0, 2)).execute()
      const dayOnly = await call("GET", `/v1/orgs/${orgA}/projects`, alice)
      const dayOnlyCost = BigInt(
        ((dayOnly.json.data as Array<Record<string, unknown>>).find(
          (project) => project.id === projectId,
        )?.costMicroUsd ?? "0") as string,
      )

      expect(withAllCost).toBe(dayOnlyCost)
      await db.deleteFrom("usageRollup").where("id", "in", ids).execute()
    })

    it("shows the region of the project's backend service, and null before it has one", async () => {
      const { id: projectId } = await ownProject("Regioned")

      const before = await call("GET", `/v1/orgs/${orgA}/projects`, alice)
      const beforeEntry = (before.json.data as Array<Record<string, unknown>>).find(
        (project) => project.id === projectId,
      )
      // A project has no region of its own — it is where its *data* lives that matters, and that is
      // a property of a backend service it may not have yet.
      expect(beforeEntry?.region).toBeNull()

      const region = await db.selectFrom("region").select(["id", "code"]).executeTakeFirstOrThrow()
      const serviceId = v7()
      await db
        .insertInto("backendService")
        .values({
          id: serviceId,
          organizationId: orgAId,
          projectId,
          regionId: region.id,
          name: "Queue",
          kind: "valkey",
          status: "active",
        })
        .execute()

      const after = await call("GET", `/v1/orgs/${orgA}/projects`, alice)
      const afterEntry = (after.json.data as Array<Record<string, unknown>>).find(
        (project) => project.id === projectId,
      )
      expect(afterEntry?.region).toBe(region.code)

      await db.deleteFrom("backendService").where("id", "=", serviceId).execute()
    })

    it("flags a fork only while its latest sync says it is behind", async () => {
      const { id: projectId, repositoryId } = await ownProject("Behind")

      const olderId = v7()
      await db
        .insertInto("upstreamSyncRun")
        .values({
          id: olderId,
          repositoryId,
          branch: "main",
          behindBy: 7,
          aheadBy: 0,
          // a run that found the fork behind and opened a PR for it
          outcome: "pr_opened",
          createdAt: new Date(Date.now() - 60_000),
        })
        .execute()

      const behind = await call("GET", `/v1/orgs/${orgA}/projects`, alice)
      expect(
        (behind.json.data as Array<Record<string, unknown>>).find((entry) => entry.id === projectId)
          ?.hasUpstreamUpdate,
      ).toBe(true)

      /*
        A newer run saying "up to date" must turn the flag off.

        Keyed on the *latest* run rather than on any run: a repository that was behind last week and
        has since been merged is not behind now, and a flag that lit up on history would never go
        out again.
      */
      const newerId = v7()
      await db
        .insertInto("upstreamSyncRun")
        .values({
          id: newerId,
          repositoryId,
          branch: "main",
          behindBy: 0,
          aheadBy: 0,
          outcome: "up_to_date",
        })
        .execute()

      const merged = await call("GET", `/v1/orgs/${orgA}/projects`, alice)
      expect(
        (merged.json.data as Array<Record<string, unknown>>).find((entry) => entry.id === projectId)
          ?.hasUpstreamUpdate,
      ).toBe(false)

      await db.deleteFrom("upstreamSyncRun").where("id", "in", [olderId, newerId]).execute()
    })

    it("shows a project the same cost on its own page as in the list", async () => {
      // Two code paths that disagree about money is worse than either being wrong: a customer
      // cannot tell which one to believe.
      const { id: projectId } = await ownProject("Consistent")

      const list = await call("GET", `/v1/orgs/${orgA}/projects`, alice)
      const fromList = (list.json.data as Array<Record<string, unknown>>).find(
        (entry) => entry.id === projectId,
      )
      const detail = await call("GET", `/v1/orgs/${orgA}/projects/${projectId}`, alice)

      expect(detail.json.costMicroUsd).toBe(fromList?.costMicroUsd)
      expect(detail.json.region).toBe(fromList?.region)
      expect(detail.json.hasUpstreamUpdate).toBe(fromList?.hasUpstreamUpdate)
    })
  })

  /*
    Last in the file, deliberately.

    These tests add a repository and several projects to organization A, and earlier suites assert
    exact counts of both — "the repository list holds exactly one row", "the repository is kept while
    one project still uses it". Running here means those assertions see the fixture they were written
    against.
  */
  describe("groups", () => {
    let groupId = ""
    let childId = ""
    /*
      Its own repository, not the shared fixture.

      These tests add several projects, and the delete suite below counts how many live on the
      repository it is working with — sharing one made this file order-dependent in a way whose
      symptom was an unrelated test asserting `5` where it wanted `1`.
    */
    let groupRepositoryId = ""

    beforeAll(async () => {
      groupRepositoryId = v7()
      await db
        .insertInto("repository")
        .values({
          id: groupRepositoryId,
          organizationId: orgAId,
          githubRepoId: BigInt("991001"),
          ownerLogin: "acme",
          name: "grouped-repo",
          provenance: "new",
        })
        .execute()
    })

    it("creates a group, which is ready immediately and provisions nothing", async () => {
      const response = await call("POST", `/v1/orgs/${orgA}/projects`, alice, {
        name: "Reddit Clone",
        isGroup: true,
        source: { type: "repository", repositoryId: groupRepositoryId },
      })

      expect(response.status).toBe(201)
      const project = response.json.project as Json
      groupId = project.id as string

      expect(project.isGroup).toBe(true)
      /*
        `ready`, not `creating`.

        There is no repository to fork and no artifact to publish, so a group left in `creating`
        would wait forever on a job with no work to do.
      */
      expect(project.state).toBe("ready")
    })

    it("allows a second group on the same repository", async () => {
      // The index predicate exists for exactly this. A group's rootDir is `.` by definition, so
      // without excluding groups the second one collides with the first.
      const response = await call("POST", `/v1/orgs/${orgA}/projects`, alice, {
        name: "Reddit Clone Staging",
        isGroup: true,
        source: { type: "repository", repositoryId: groupRepositoryId },
      })

      expect(response.status).toBe(201)
      expect((response.json.project as Json).isGroup).toBe(true)
    })

    /*
      A group at the repository root must not block a project that builds from it.

      This is what `findConflictingTarget`'s `is_group = false` filter buys, and nothing else covers
      it: the create route short-circuits that query for groups, so removing the filter breaks only
      this direction — an ordinary project refused because a *group* already "occupies" `.`.
    */
    it("lets a deployable project build from the root a group already sits at", async () => {
      const response = await call("POST", `/v1/orgs/${orgA}/projects`, alice, {
        name: "Root Build",
        rootDir: ".",
        source: { type: "repository", repositoryId: groupRepositoryId },
      })

      expect(response.status).toBe(201)
      expect((response.json.project as Json).rootDir).toBe(".")
      expect((response.json.project as Json).isGroup).toBe(false)
    })

    it("places a project inside a group", async () => {
      /*
        A project made here, not the shared fixture.

        The delete suite runs before this one and soft-deletes what it works with, so reaching for a
        project another describe created makes this depend on whether that one got as far as
        deleting it.
      */
      const created = await call("POST", `/v1/orgs/${orgA}/projects`, alice, {
        name: "Grouped Child",
        rootDir: "apps/child",
        source: { type: "repository", repositoryId: groupRepositoryId },
      })
      childId = (created.json.project as Json).id as string

      const response = await call("PATCH", `/v1/orgs/${orgA}/projects/${childId}`, alice, {
        parentProjectId: groupId,
      })

      expect(response.status).toBe(200)
      expect(response.json.parentProjectId).toBe(groupId)
    })

    it("refuses a parent that is not a group", async () => {
      const response = await call("PATCH", `/v1/orgs/${orgA}/projects/${groupId}`, alice, {
        parentProjectId: childId,
      })

      expect(response.status).toBe(400)
      expect(JSON.stringify(response.json)).toContain("not a group")
    })

    it("refuses a project as its own group", async () => {
      const response = await call("PATCH", `/v1/orgs/${orgA}/projects/${groupId}`, alice, {
        parentProjectId: groupId,
      })

      expect(response.status).toBe(400)
    })

    it("converts a project that has never served into a group", async () => {
      const created = await call("POST", `/v1/orgs/${orgA}/projects`, alice, {
        name: "Never Deployed",
        rootDir: "apps/never",
        source: { type: "repository", repositoryId: groupRepositoryId },
      })
      const id = (created.json.project as Json).id as string

      const response = await call("PATCH", `/v1/orgs/${orgA}/projects/${id}`, alice, {
        isGroup: true,
      })

      expect(response.status).toBe(200)
      expect(response.json.isGroup).toBe(true)
    })

    /*
      The guard that matters.

      A group serves nothing, so converting a project that *is* serving would take the site down
      with no deployment event to explain it — the hostname would simply stop being republished.
    */
    it("refuses to convert a project that has deployed", async () => {
      const created = await call("POST", `/v1/orgs/${orgA}/projects`, alice, {
        name: "Has Served",
        rootDir: "apps/served",
        source: { type: "repository", repositoryId: groupRepositoryId },
      })
      const id = (created.json.project as Json).id as string

      await db
        .insertInto("deployment")
        .values({
          id: v7(),
          projectId: id,
          kind: "production",
          gitSha: "a".repeat(40),
          status: "ready",
        })
        .execute()

      const response = await call("PATCH", `/v1/orgs/${orgA}/projects/${id}`, alice, {
        isGroup: true,
      })

      expect(response.status).toBe(400)
      expect(JSON.stringify(response.json)).toContain("take the site down")
    })

    it("refuses to nest a group inside a group", async () => {
      const response = await call("PATCH", `/v1/orgs/${orgA}/projects/${groupId}`, alice, {
        isGroup: true,
        parentProjectId: groupId,
      })

      expect(response.status).toBe(400)
    })
  })
})
