import { open } from "@lib/envelope"
import { rolePasswordContext } from "@lib/services"
import { db } from "@sproutos/db"
import { Hono } from "hono"
import { describeRoute } from "hono-typebox-openapi"
import { resolver } from "hono-typebox-openapi/typebox"
import { Type } from "typebox"
import { validator } from "../utils/validator"

/**
 * Where `pg-proxy` should connect onward for a tenant.
 *
 * The customer authenticates to the proxy with a SproutOS credential. The proxy then has to reach
 * the actual database — a Neon endpoint with a Neon role and password that the customer must never
 * see. Those live sealed under KMS in `database_role`, and **this endpoint is how the proxy opens
 * them**, because the sealing is `@lib/envelope` in TypeScript and duplicating an envelope format
 * across two languages is how a divergence becomes a security bug.
 *
 * ## This returns a plaintext database password over HTTP
 *
 * Said plainly because it is the uncomfortable part. The mitigations are that it is on the
 * `/internal` prefix, reachable only inside the VPC, and that the alternative — a KMS client and a
 * second implementation of the envelope format in Rust — is worse in a way that is harder to see.
 *
 * ## Suspension is enforced here
 *
 * A suspended service resolves to nothing, so the proxy cannot connect at all. That is what makes
 * `suspend` mean something: Neon wakes a compute on connection, so refusing to *make* the
 * connection is the only thing that actually stops a suspended database from costing money.
 */

const resolveRequest = Type.Object({
  backend_service_id: Type.String({ format: "uuid" }),
  /*
    Which branch, when the credential names one.

    Absent means the primary branch, which is what every credential meant before branch credentials
    existed. The proxy reads this off `service_credential.database_branch_id` — it is not something
    a customer sends, and a branch belonging to another service is refused below rather than
    trusted, because "the proxy asked for it" is not authorization.
  */
  database_branch_id: Type.Optional(Type.String({ format: "uuid" })),
})

const resolveResponse = Type.Object({
  host: Type.String(),
  port: Type.Integer(),
  database: Type.String(),
  role: Type.String(),
  password: Type.String(),
})

const pgResolve: Hono = new Hono().post(
  "/pg/resolve",
  describeRoute({
    description:
      "The backend connection details for one tenant database. Called by pg-proxy on connection, not by users.",
    responses: {
      200: {
        description: "Where to connect and with what",
        content: { "application/json": { schema: resolver(resolveResponse) } },
      },
      404: { description: "No live database for that service, or the service is suspended" },
    },
  }),
  validator("json", resolveRequest),
  async (c) => {
    const { backend_service_id, database_branch_id } = c.req.valid("json")

    /*
      One query, joined through to the organization.

      `backend_service.status = 'active'` is the suspension check and
      `organization.deleted_at is null` is the belt: a service whose organization was deleted by a
      path that forgot to suspend it must not still be reachable. Authorization that depends on
      every writer remembering two things eventually fails open — the same reasoning the Rust
      credential store already applies to its own lookup.
    */
    const row = await db
      .selectFrom("databaseRole")
      .innerJoin("databaseBranch", "databaseBranch.id", "databaseRole.databaseBranchId")
      .innerJoin("databaseInstance", "databaseInstance.id", "databaseBranch.databaseInstanceId")
      .innerJoin("backendService", "backendService.id", "databaseInstance.backendServiceId")
      .innerJoin("organization", "organization.id", "backendService.organizationId")
      .select([
        "databaseRole.id as roleId",
        "databaseRole.roleName",
        "databaseRole.passwordCiphertext",
        "databaseRole.passwordWrappedDek",
        "databaseRole.passwordKmsKeyId",
        "databaseBranch.host",
      ])
      .where("databaseInstance.backendServiceId", "=", backend_service_id)
      /*
        Shared Sprout databases are handled by pg-proxy's configured backend.

        Returning their local `database_branch.host` here makes the resolver reinterpret that
        shared backend as a managed remote endpoint. Resolved endpoints require TLS, so the local
        shared cluster is then rejected even though the proxy's configured backend correctly has
        TLS disabled. More importantly, production would route a legacy Sprout database through
        the wrong configuration path. A 404 is the resolver contract for "use the configured
        backend", and only Neon has per-tenant connection details to resolve.
      */
      .where("databaseInstance.provider", "=", "neon")
      .where("databaseInstance.deletedAt", "is", null)
      /*
        The named branch, or the primary.

        Both arms stay joined through `database_instance.backend_service_id`, so a branch id
        belonging to a *different* service resolves to no row rather than to that service's
        database. That is the whole authorization check and it is one `where` clause: the branch is
        only reachable if it lives under the service the credential authenticated for.
      */
      .where((eb) =>
        database_branch_id === undefined
          ? eb("databaseBranch.kind", "=", "primary")
          : eb("databaseBranch.id", "=", database_branch_id),
      )
      .where("backendService.status", "=", "active")
      .where("backendService.deletedAt", "is", null)
      .where("organization.deletedAt", "is", null)
      .executeTakeFirst()

    if (row === undefined || row.host === null) {
      return c.json({ message: "No live database for that service" }, 404)
    }

    const password = await open(
      {
        ciphertext: row.passwordCiphertext,
        wrappedDek: row.passwordWrappedDek,
        kmsKeyId: row.passwordKmsKeyId,
      },
      rolePasswordContext(row.roleId),
    )

    // Neon's host carries no port; it is always 5432 and the URI omits it.
    const [host, port] = row.host.includes(":") ? row.host.split(":") : [row.host, "5432"]

    return c.json({
      host,
      port: Number(port),
      // Neon's own database name, which is `neondb` by default — not the `sprout_db_…` name the
      // customer sees. Translating between the two is exactly what this proxy is for.
      database: "neondb",
      role: row.roleName,
      password,
    })
  },
)

export default pgResolve
