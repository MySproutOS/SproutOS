import { domainToASCII } from "node:url"
import {
  crudAuditLog,
  crudManagedCustomDomainPolicy,
  fetchManagedCustomDomainPolicy,
  fetchOrganization,
} from "@lib/dao"
import { CUSTOM_DOMAIN_KINDS, enqueue } from "@lib/jobs"
import { db } from "@sproutos/db"
import { Hono } from "hono"
import { describeRoute } from "hono-typebox-openapi"
import { resolver } from "hono-typebox-openapi/typebox"
import { getDomain } from "tldts"
import { ErrorSchemaResponse } from "../utils/common.serializer"
import { throwBadRequest, throwConflict, throwNotFound } from "../utils/http-exception"
import { auditContext } from "../utils/request-context"
import { validator } from "../utils/validator"
import {
  managedDomainPolicySchemaCreateRequest,
  managedDomainPolicySchemaListResponse,
  managedDomainPolicySchemaParam,
  managedDomainPolicySchemaResponse,
  managedDomainPolicySchemaUpdateRequest,
} from "./managed-domain-policies.serializer"
import { adminAuthMiddleware } from "./middleware"

const errorResponse = {
  content: { "application/json": { schema: resolver(ErrorSchemaResponse) } },
}

export function normalizeManagedSuffix(input: string): string | null {
  const raw = input.trim().replace(/\.$/, "").toLowerCase()
  const ascii = domainToASCII(raw).toLowerCase()
  if (ascii === "" || raw !== ascii || ascii.includes("*") || ascii.includes("xn--")) return null
  if (getDomain(ascii, { allowPrivateDomains: true }) !== ascii) return null
  if (
    !ascii
      .split(".")
      .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$|^[a-z0-9]$/.test(label))
  ) {
    return null
  }
  return ascii
}

function present(row: {
  id: string
  suffix: string
  organizationId: string
  status: string
  createdByUserId: string
  updatedByUserId: string
  disabledByUserId: string | null
  createdAt: Date
  updatedAt: Date
  disabledAt: Date | null
}) {
  return {
    id: row.id,
    suffix: row.suffix,
    organizationId: row.organizationId,
    status: row.status as "active" | "disabled",
    createdByUserId: row.createdByUserId,
    updatedByUserId: row.updatedByUserId,
    disabledByUserId: row.disabledByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    disabledAt: row.disabledAt?.toISOString() ?? null,
  }
}

async function enqueueRetiredDomains(
  transaction: Parameters<typeof enqueue>[0],
  domains: Array<{ id: string; organizationId: string }>,
) {
  const minute = new Date().toISOString().slice(0, 16)
  await Promise.all(
    domains.map((domain) =>
      enqueue(transaction, {
        kind: CUSTOM_DOMAIN_KINDS.reconcile,
        organizationId: domain.organizationId,
        payload: { domainId: domain.id },
        idempotencyKey: `${CUSTOM_DOMAIN_KINDS.reconcile}:${domain.id}:${minute}`,
        maxAttempts: 5,
      }),
    ),
  )
}

const app = new Hono()
  .use(adminAuthMiddleware)
  .get(
    "/",
    describeRoute({
      description: "Lists managed custom-domain policies",
      responses: {
        200: {
          description: "Policies",
          content: {
            "application/json": { schema: resolver(managedDomainPolicySchemaListResponse) },
          },
        },
      },
    }),
    async (c) =>
      c.json({ data: (await fetchManagedCustomDomainPolicy(db).listAll()).map(present) }),
  )
  .get(
    "/:policyId",
    describeRoute({
      description: "Gets one managed custom-domain policy",
      responses: {
        200: {
          description: "Policy",
          content: { "application/json": { schema: resolver(managedDomainPolicySchemaResponse) } },
        },
        404: { description: "Policy not found", ...errorResponse },
      },
    }),
    validator("param", managedDomainPolicySchemaParam),
    async (c) => {
      const row = await fetchManagedCustomDomainPolicy(db).getOne(c.req.valid("param").policyId, [
        "id",
        "suffix",
        "organizationId",
        "status",
        "createdByUserId",
        "updatedByUserId",
        "disabledByUserId",
        "createdAt",
        "updatedAt",
        "disabledAt",
      ])
      if (row === undefined) return throwNotFound(c, "Policy not found")
      return c.json(present(row))
    },
  )
  .post(
    "/",
    describeRoute({
      description: "Creates an organization-bound managed domain suffix",
      responses: {
        201: {
          description: "Policy created",
          content: { "application/json": { schema: resolver(managedDomainPolicySchemaResponse) } },
        },
        400: { description: "Invalid suffix", ...errorResponse },
        404: { description: "Organization not found", ...errorResponse },
        409: { description: "Suffix already managed", ...errorResponse },
      },
    }),
    validator("json", managedDomainPolicySchemaCreateRequest),
    async (c) => {
      const input = c.req.valid("json")
      const suffix = normalizeManagedSuffix(input.suffix)
      if (suffix === null) return throwBadRequest(c, "Suffix must be an ASCII registrable domain")
      if ((await fetchOrganization(db).getOne(input.organizationId, ["id"])) === undefined) {
        return throwNotFound(c, "Organization not found")
      }
      try {
        const row = await db.transaction().execute(async (tx) => {
          const created = await crudManagedCustomDomainPolicy(tx).create({
            suffix,
            organizationId: input.organizationId,
            createdByUserId: c.var.user.id,
            updatedByUserId: c.var.user.id,
          })
          await crudAuditLog(tx).record({
            organizationId: input.organizationId,
            actorUserId: c.var.user.id,
            action: "admin:managed-domain-policy:create",
            resourceSrn: `srn:sproutos:domains::managed-policy/${created.id}`,
            after: { suffix, organizationId: input.organizationId },
            ...auditContext(c),
          })
          return created
        })
        return c.json(present(row), 201)
      } catch (error) {
        if ((error as { code?: unknown }).code === "23505") {
          return throwConflict(c, "That suffix already has a managed policy")
        }
        throw error
      }
    },
  )
  .patch(
    "/:policyId",
    describeRoute({
      description: "Updates or disables a managed domain policy",
      responses: {
        200: {
          description: "Policy updated",
          content: { "application/json": { schema: resolver(managedDomainPolicySchemaResponse) } },
        },
        400: { description: "Invalid update", ...errorResponse },
        404: { description: "Policy or organization not found", ...errorResponse },
        409: { description: "Attached domains prevent reassignment", ...errorResponse },
      },
    }),
    validator("param", managedDomainPolicySchemaParam),
    validator("json", managedDomainPolicySchemaUpdateRequest),
    async (c) => {
      const { policyId } = c.req.valid("param")
      const input = c.req.valid("json")
      const existing = await fetchManagedCustomDomainPolicy(db).getOne(policyId, [
        "id",
        "suffix",
        "organizationId",
        "status",
      ])
      if (existing === undefined) return throwNotFound(c, "Policy not found")
      const suffix =
        input.suffix === undefined ? existing.suffix : normalizeManagedSuffix(input.suffix)
      if (suffix === null) return throwBadRequest(c, "Suffix must be an ASCII registrable domain")
      const organizationId = input.organizationId ?? existing.organizationId
      if ((await fetchOrganization(db).getOne(organizationId, ["id"])) === undefined) {
        return throwNotFound(c, "Organization not found")
      }
      const reassigned = suffix !== existing.suffix || organizationId !== existing.organizationId
      if (reassigned && (await fetchManagedCustomDomainPolicy(db).countAttached(policyId)) > 0) {
        return throwConflict(c, "Delete attached managed domains before reassigning this policy")
      }
      try {
        const row = await db.transaction().execute(async (tx) => {
          const retired =
            input.status === "disabled"
              ? await crudManagedCustomDomainPolicy(tx).retire(policyId, c.var.user.id, false)
              : undefined
          if (retired !== undefined) await enqueueRetiredDomains(tx, retired.domains)
          const updated =
            retired?.policy ??
            (await crudManagedCustomDomainPolicy(tx).update(policyId, {
              suffix,
              organizationId,
              status: input.status ?? existing.status,
              disabledAt: input.status === "active" ? null : undefined,
              disabledByUserId: input.status === "active" ? null : undefined,
              updatedByUserId: c.var.user.id,
            }))
          if (updated === undefined) return undefined
          await crudAuditLog(tx).record({
            organizationId,
            actorUserId: c.var.user.id,
            action: "admin:managed-domain-policy:update",
            resourceSrn: `srn:sproutos:domains::managed-policy/${policyId}`,
            before: existing,
            after: { suffix, organizationId, status: updated.status },
            ...auditContext(c),
          })
          return updated
        })
        if (row === undefined) return throwNotFound(c, "Policy not found")
        return c.json(present(row))
      } catch (error) {
        if ((error as { code?: unknown }).code === "23505") {
          return throwConflict(c, "That suffix already has a managed policy")
        }
        throw error
      }
    },
  )
  .delete(
    "/:policyId",
    describeRoute({
      description: "Soft-deletes a managed policy and tears down attached domains",
      responses: {
        204: { description: "Policy deletion started" },
        404: { description: "Policy not found", ...errorResponse },
      },
    }),
    validator("param", managedDomainPolicySchemaParam),
    async (c) => {
      const { policyId } = c.req.valid("param")
      const row = await db.transaction().execute(async (tx) => {
        const deleted = await crudManagedCustomDomainPolicy(tx).retire(
          policyId,
          c.var.user.id,
          true,
        )
        if (deleted === undefined) return undefined
        await enqueueRetiredDomains(tx, deleted.domains)
        await crudAuditLog(tx).record({
          organizationId: deleted.policy.organizationId,
          actorUserId: c.var.user.id,
          action: "admin:managed-domain-policy:delete",
          resourceSrn: `srn:sproutos:domains::managed-policy/${policyId}`,
          before: {
            suffix: deleted.policy.suffix,
            organizationId: deleted.policy.organizationId,
          },
          ...auditContext(c),
        })
        return deleted.policy
      })
      if (row === undefined) return throwNotFound(c, "Policy not found")
      return c.body(null, 204)
    },
  )

export default app
