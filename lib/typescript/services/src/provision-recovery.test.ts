import { CreateBucketCommand, HeadBucketCommand, PutBucketCorsCommand } from "@aws-sdk/client-s3"
import { describe, expect, it } from "vitest"
import { databaseNameFor, roleNameFor } from "./naming"
import { reconcileNeonProvision } from "./neon-postgres"
import { reconcileObjectStorageProvider } from "./object-storage"
import { reconcileSproutPostgresProvider } from "./postgres"

const serviceId = "01991aa2-2cb8-7000-8000-000000000001"

describe("provider-success response-loss recovery", () => {
  it("adopts the one exact Neon project and its provider identifiers", async () => {
    const calls: string[] = []
    const api = {
      listProjects: (search?: string) => {
        calls.push(`projects:${search}`)
        return Promise.resolve([
          { id: "neon-project", name: `sproutos-${serviceId}`, region_id: "aws-us-east-1" },
          { id: "other", name: `sproutos-${serviceId}-other`, region_id: "aws-us-east-1" },
        ])
      },
      listBranches: (projectId: string) => {
        calls.push(`branches:${projectId}`)
        return Promise.resolve([{ id: "br-main", name: "main", primary: true }])
      },
      listDatabases: (projectId: string, branchId: string) => {
        calls.push(`databases:${projectId}:${branchId}`)
        return Promise.resolve([{ name: "neondb", owner_name: "neondb_owner" }])
      },
      listRoles: (projectId: string, branchId: string) => {
        calls.push(`roles:${projectId}:${branchId}`)
        return Promise.resolve([{ name: "neondb_owner" }])
      },
      getConnectionUri: (input: {
        projectId: string
        branchId: string
        database: string
        role: string
      }) => {
        calls.push(`uri:${input.projectId}:${input.branchId}:${input.database}:${input.role}`)
        return Promise.resolve("postgres://neondb_owner:secret@ep.example/neondb")
      },
    }

    const adopted = await reconcileNeonProvision(api, serviceId)

    expect(adopted).toMatchObject({
      project: { id: "neon-project" },
      branch: { id: "br-main" },
    })
    expect(calls).toEqual([
      `projects:sproutos-${serviceId}`,
      "branches:neon-project",
      "databases:neon-project:br-main",
      "roles:neon-project:br-main",
      "uri:neon-project:br-main:neondb:neondb_owner",
    ])
  })

  it("resets and adopts an exact shared-Postgres role/database without recreating either", async () => {
    const statements: string[] = []
    const role = roleNameFor(serviceId)
    const database = databaseNameFor(serviceId)
    const client = {
      query: (statement: string) => {
        statements.push(statement)
        if (statement.startsWith("select rolname")) return Promise.resolve({ rows: [{ role }] })
        if (statement.startsWith("select pg_get_userbyid")) {
          return Promise.resolve({ rows: [{ owner: role }] })
        }
        return Promise.resolve({ rows: [] })
      },
    }

    await reconcileSproutPostgresProvider(client as never, serviceId, "replacement-secret")

    expect(statements.some((statement) => statement.startsWith("create role"))).toBe(false)
    expect(statements.some((statement) => statement.startsWith("create database"))).toBe(false)
    expect(statements).toContain(`alter role ${role} login password 'replacement-secret'`)
    expect(statements).toContain(`grant all privileges on database ${database} to ${role}`)
  })

  it("heads the deterministic legacy S3 bucket and never replays CreateBucket", async () => {
    const commands: unknown[] = []
    const s3 = {
      send: (command: unknown) => {
        commands.push(command)
        return Promise.resolve({})
      },
    }

    await reconcileObjectStorageProvider(s3, {}, "v-deterministic")

    expect(commands[0]).toBeInstanceOf(HeadBucketCommand)
    expect(commands[1]).toBeInstanceOf(PutBucketCorsCommand)
    expect(commands.some((command) => command instanceof CreateBucketCommand)).toBe(false)
  })
})
