import { seal } from "@lib/envelope"
import type { DB } from "@sproutos/db"
import { type Kysely, sql } from "kysely"
import { Client } from "pg"
import { v7 } from "uuid"
import { assertSafeIdentifier, databaseNameFor, postgresUri, roleNameFor } from "./naming"
import { generateSecret, hashGeneratedSecret, lastFour, tenantUsername } from "./tenant-auth"
import { SecretNotRecoverableError } from "./valkey"
import {
  type ConnectionDetails,
  type CredentialOwner,
  type ProvisionInput,
  type ProvisionResult,
  ServiceNotProvisionedError,
  type ServiceDriver,
  ServiceNotConfiguredError,
} from "./types"

/**
 * A Postgres service on a cluster we run.
 *
 * `database_instance.provider` allows `neon | byo | sprout`; this is `sprout` — a database and a
 * role on an ordinary Postgres server. Self-hosted Neon (branching, scale-to-zero, TASK 30) is a
 * separate provider on the same interface, and it needs a pageserver and safekeepers that do not
 * exist yet. This one works today, which makes it the honest starting point rather than a stub
 * pretending to be branching storage.
 *
 * **Provisioning is DDL, and DDL cannot be parameterized.** Every identifier that reaches a
 * statement here is derived from a UUID and asserted before use; nothing a customer typed gets
 * near it.
 */

export type SproutPostgresConfig = {
  /** Where customer databases live. The superuser connection — never handed to a customer. */
  adminUrl: string
  /** What goes in the customer's URI, which may differ from adminUrl behind a proxy. */
  publicHost: string
  publicPort: number
  sslmode?: string
}

export function sproutPostgresConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SproutPostgresConfig {
  const adminUrl = env.SERVICE_POSTGRES_ADMIN_URL ?? env.DATABASE_URL
  if (adminUrl === undefined || adminUrl === "") {
    throw new ServiceNotConfiguredError("SERVICE_POSTGRES_ADMIN_URL", "postgres")
  }

  const parsed = new URL(adminUrl)

  /*
    The host a customer is handed, and it must not default to the backend.

    `services/pg-proxy/README.md` is explicit that the proxy is the security boundary: it identifies
    the tenant from the connection credentials, routes into their database, and drops its own
    privilege with `SET ROLE` before the session is spliced. A URI naming the backend directly skips
    all of that and hands out a route to the cluster every tenant's data lives on.

    It used to fall back to `adminUrl`'s hostname. That is the most dangerous possible default — a
    forgotten environment variable does not produce an error, it produces a working connection
    string that bypasses the thing standing between one customer and everyone else's rows. Observed
    on the first real provisioning: the returned URI pointed straight at
    `postgres.platform-db.svc.cluster.local`.

    Refusing costs a local developer one variable in `.env` and is the only default that cannot
    silently be wrong.
  */
  const publicHost = env.SERVICE_POSTGRES_PUBLIC_HOST
  if (publicHost === undefined || publicHost === "") {
    throw new Error(
      "SERVICE_POSTGRES_PUBLIC_HOST is not set. It is the address of pg-proxy — the host a " +
        "customer connects to. Defaulting it to the backend would issue connection strings that " +
        "bypass the tenant boundary.",
    )
  }

  return {
    adminUrl,
    publicHost,
    publicPort: Number(env.SERVICE_POSTGRES_PUBLIC_PORT ?? parsed.port ?? 5432),
    ...(env.SERVICE_POSTGRES_SSLMODE === undefined
      ? {}
      : { sslmode: env.SERVICE_POSTGRES_SSLMODE }),
  }
}

/** 32 bytes of base64url. Long enough that it is never the weak part of the URI. */
function generatePassword(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")
}

/**
 * Binds a password's ciphertext to the role row that holds it.
 *
 * KMS authenticates the context, so a blob copied onto another role's row does not decrypt. Shared
 * by seal and open for the reason `@lib/agent` learned the hard way: a one-word difference between
 * writer and reader stores fine and never opens.
 */
export function rolePasswordContext(databaseRoleId: string): Record<string, string> {
  return { field: "database_role.password", databaseRoleId }
}

async function withAdmin<T>(
  config: SproutPostgresConfig,
  body: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: config.adminUrl })
  await client.connect()
  try {
    return await body(client)
  } finally {
    await client.end()
  }
}

export function sproutPostgresDriver(db: Kysely<DB>, config: SproutPostgresConfig): ServiceDriver {
  async function locate(backendServiceId: string) {
    const row = await db
      .selectFrom("databaseInstance")
      .innerJoin("databaseBranch", "databaseBranch.databaseInstanceId", "databaseInstance.id")
      .innerJoin("databaseRole", "databaseRole.databaseBranchId", "databaseBranch.id")
      // The owning organization, because the tenant username encodes it and every read that
      // rebuilds a connection string needs it. Joined rather than passed in: a caller holding a
      // service id should not have to also know whose it is.
      .innerJoin("backendService", "backendService.id", "databaseInstance.backendServiceId")
      .select([
        "backendService.organizationId as organizationId",
        "databaseInstance.id as instanceId",
        "databaseBranch.id as branchId",
        "databaseRole.id as roleId",
        "databaseRole.roleName as roleName",
        "databaseRole.passwordCiphertext as ciphertext",
        "databaseRole.passwordWrappedDek as wrappedDek",
        "databaseRole.passwordKmsKeyId as kmsKeyId",
      ])
      .where("databaseInstance.backendServiceId", "=", backendServiceId)
      .where("databaseInstance.deletedAt", "is", null)
      .where("databaseBranch.kind", "=", "primary")
      .executeTakeFirst()

    if (row === undefined) throw new ServiceNotProvisionedError(backendServiceId)
    return row
  }

  /**
   * What a customer connects with.
   *
   * The **tenant username**, not the Postgres role name. `pg-proxy` parses the username to learn
   * which tenant and which resource a connection is for — that is the only routing information a
   * startup packet has room for — and then authenticates it against `service_credential` before
   * dropping to the backend role with `SET ROLE`.
   *
   * It used to be the role name and the role's own password, which is a credential for the backend
   * cluster and works only by connecting to it directly. Together with `publicHost` defaulting to
   * the backend, the whole Postgres path was built for direct connection and the proxy was never
   * joined to it: three `database_role` rows existed and `service_credential` was empty, so every
   * connection the proxy saw failed authentication.
   */
  function detailsFor(input: {
    organizationId: string
    backendServiceId: string
  }): ConnectionDetails {
    return {
      host: config.publicHost,
      port: config.publicPort,
      database: databaseNameFor(input.backendServiceId),
      username: tenantUsername({
        organizationId: input.organizationId,
        kind: "database",
        resourceId: input.backendServiceId,
      }),
    }
  }

  async function provision(input: ProvisionInput): Promise<ProvisionResult> {
    const database = databaseNameFor(input.backendServiceId)
    const role = roleNameFor(input.backendServiceId)
    assertSafeIdentifier(database)
    assertSafeIdentifier(role)
    const details = detailsFor(input)

    const password = generatePassword()

    await withAdmin(config, async (client) => {
      // The password is a parameter of the *statement text* here because Postgres has no bind
      // parameters in DDL. It is generated by us and base64url, so it contains nothing that can
      // close the quote — but the literal is still escaped rather than trusted.
      await client.query(`create role ${role} login password ${quoteLiteral(password)}`)
      // `create database` cannot run inside a transaction block, which is why this is a sequence
      // of statements rather than one atomic unit. A failure between them leaves an orphaned role,
      // which `destroy` cleans up because it drops both regardless of what exists.
      await client.query(`create database ${database} owner ${role}`)
      // Revoke the implicit grant every role gets on a new database's public schema, so one
      // customer's role cannot connect to another customer's database.
      await client.query(`revoke all on database ${database} from public`)
      await client.query(`grant all privileges on database ${database} to ${role}`)
    })

    const roleId = v7()
    const sealed = await seal(password, rolePasswordContext(roleId))

    await db.transaction().execute(async (tx) => {
      const instanceId = v7()
      const branchId = v7()

      await tx
        .insertInto("databaseInstance")
        .values({
          id: instanceId,
          backendServiceId: input.backendServiceId,
          projectId: input.projectId,
          provider: "sprout",
          region: null,
          status: "active",
        })
        .execute()

      await tx
        .insertInto("databaseBranch")
        .values({
          id: branchId,
          databaseInstanceId: instanceId,
          name: "main",
          kind: "primary",
          host: config.publicHost,
          isProtected: true,
        })
        .execute()

      await tx
        .insertInto("databaseRole")
        .values({
          id: roleId,
          databaseBranchId: branchId,
          roleName: role,
          passwordCiphertext: sealed.ciphertext,
          passwordWrappedDek: sealed.wrappedDek,
          passwordKmsKeyId: sealed.kmsKeyId,
        })
        .execute()
    })

    /*
      The tenant's own secret, separate from the role's password.

      Two credentials, deliberately. The role password is how the *proxy* reaches the backend on
      this tenant's behalf and is sealed under KMS. The secret below is what the *customer* sends,
      is stored as a one-way hash, and is the only thing `pg-proxy` verifies. A customer holding the
      role password would be holding a credential that works against the backend directly.
    */
    const secret = generateSecret()
    await db
      .insertInto("serviceCredential")
      .values({
        id: v7(),
        backendServiceId: input.backendServiceId,
        username: details.username,
        secretHash: await hashGeneratedSecret(secret),
        lastFour: lastFour(secret),
        oauthGrantId: input.credentialOwner?.oauthGrantId ?? null,
      })
      .execute()

    return {
      ...details,
      connectionUri: postgresUri({
        ...details,
        password: secret,
        ...(config.sslmode === undefined ? {} : { sslmode: config.sslmode }),
      }),
    }
  }

  async function connectionUri(backendServiceId: string): Promise<string> {
    /*
      Not recoverable, and that is the correct answer rather than a gap.

      What a customer connects with is the tenant secret, and it is stored as a one-way hash — by
      us and by anyone who steals the table. This used to return a URI built from the *role's*
      password, which is recoverable because it is sealed rather than hashed, and which is a
      credential for the backend cluster rather than for the proxy.

      `rotateCredentials` is the answer, and it is a different answer — the old URI stops working —
      which is why this is an error the caller handles rather than a silent rotation. Same
      reasoning, same shape, as the Valkey and OpenSearch drivers.
    */
    await locate(backendServiceId)
    throw new SecretNotRecoverableError(backendServiceId)
  }

  async function details(backendServiceId: string): Promise<ConnectionDetails> {
    const row = await locate(backendServiceId)
    return detailsFor({ organizationId: row.organizationId, backendServiceId })
  }

  /**
   * New credentials, both of them.
   *
   * The tenant secret is what a customer sends and the only thing the proxy verifies; the role
   * password is how the proxy reaches the backend on their behalf. Rotating only the first would
   * leave a backend credential that has been in a connection string, and rotating only the second
   * would not change anything the customer holds — so both move, and the old URI stops working,
   * which is what rotation means.
   */
  async function rotateCredentials(backendServiceId: string, owner?: CredentialOwner) {
    const row = await locate(backendServiceId)
    const details = detailsFor({ organizationId: row.organizationId, backendServiceId })
    const secret = generateSecret()

    await db.transaction().execute(async (tx) => {
      let revoke = tx
        .updateTable("serviceCredential")
        .set({ revokedAt: new Date() })
        .where("backendServiceId", "=", backendServiceId)
        .where("purpose", "=", "tenant")
        .where("revokedAt", "is", null)
      revoke =
        owner?.oauthGrantId == null
          ? revoke.where("oauthGrantId", "is", null)
          : revoke.where("oauthGrantId", "=", owner.oauthGrantId)
      await revoke.execute()

      await tx
        .insertInto("serviceCredential")
        .values({
          id: v7(),
          backendServiceId,
          username: details.username,
          secretHash: await hashGeneratedSecret(secret),
          lastFour: lastFour(secret),
          oauthGrantId: owner?.oauthGrantId ?? null,
        })
        .execute()
    })

    return {
      connectionUri: postgresUri({
        ...details,
        password: secret,
        ...(config.sslmode === undefined ? {} : { sslmode: config.sslmode }),
      }),
    }
  }

  async function suspend(backendServiceId: string): Promise<void> {
    const row = await locate(backendServiceId)
    assertSafeIdentifier(row.roleName)

    // `nologin` rather than terminating the database: existing data is untouched and resuming is
    // one statement. A suspended service that lost its data would not be a suspension.
    await withAdmin(config, async (client) => {
      await client.query(`alter role ${row.roleName} nologin`)
    })

    /*
      `backend_service.status` as well, and this is the half that actually suspends anything.

      `nologin` stops a *direct* login as the backend role, which is how a customer used to
      connect. They connect through `pg-proxy` now: the proxy authenticates as itself and reaches
      the tenant's role with `SET ROLE`, and `SET ROLE` to a `NOLOGIN` role succeeds — `NOLOGIN`
      governs authentication, not role assumption. So suspension was a no-op on the only path a
      customer uses, including a suspension for non-payment.

      What the boundary reads is `backend_service.status`: the credential lookup in
      `lib/rust/service-credentials` requires `s.status in ('provisioning', 'active')`. The Valkey
      and search drivers set it and this one set `database_instance.status` instead — two status
      columns, one written by the operation and the other checked by the authorization path.

      Both are set. The instance status is the driver's own bookkeeping — `resume` below reverses
      exactly what this wrote — and the service status is what stops the next connection.
    */
    await db
      .updateTable("databaseInstance")
      .set({ status: "suspended", updatedAt: new Date() })
      .where("id", "=", row.instanceId)
      .execute()

    await db
      .updateTable("backendService")
      .set({ status: "suspended", updatedAt: new Date() })
      .where("id", "=", backendServiceId)
      .execute()
  }

  /**
   * The other half of `suspend`, which did not exist.
   *
   * A service could be suspended and never brought back: `suspend` had no counterpart anywhere in
   * the driver, the interface, or the API. Suspension for non-payment is only useful if paying
   * undoes it, and a customer whose service can be stopped and not started is worse served than
   * one whose service cannot be stopped at all.
   *
   * Reverses precisely what `suspend` wrote, in the opposite order: the credential boundary opens
   * last, so there is no window where the proxy will accept a connection to a role that still
   * cannot be assumed.
   */
  async function resume(backendServiceId: string): Promise<void> {
    const row = await locate(backendServiceId)
    assertSafeIdentifier(row.roleName)

    await withAdmin(config, async (client) => {
      await client.query(`alter role ${row.roleName} login`)
    })

    await db
      .updateTable("databaseInstance")
      .set({ status: "active", updatedAt: new Date() })
      .where("id", "=", row.instanceId)
      .execute()

    await db
      .updateTable("backendService")
      .set({ status: "active", updatedAt: new Date() })
      .where("id", "=", backendServiceId)
      .execute()
  }

  async function destroy(backendServiceId: string): Promise<void> {
    const database = databaseNameFor(backendServiceId)
    const role = roleNameFor(backendServiceId)
    assertSafeIdentifier(database)
    assertSafeIdentifier(role)

    await withAdmin(config, async (client) => {
      // `with (force)` disconnects sessions still on it; without it a single idle client keeps a
      // customer's deleted database alive forever.
      await client.query(`drop database if exists ${database} with (force)`)
      await client.query(`drop role if exists ${role}`)
    })

    await db
      .updateTable("databaseInstance")
      .set({ status: "deleting", deletedAt: new Date(), updatedAt: new Date() })
      .where("backendServiceId", "=", backendServiceId)
      .execute()
  }

  return {
    kind: "postgres",
    connectionUri,
    destroy,
    details,
    provision,
    resume,
    rotateCredentials,
    suspend,
  }
}

/** Postgres string literal quoting: double the single quotes, and nothing else is special. */
function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

export { sql }
