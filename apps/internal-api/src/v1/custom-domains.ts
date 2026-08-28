import { randomBytes } from "node:crypto"
import { crudAuditLog, crudCustomDomain, fetchCustomDomain, fetchProject } from "@lib/dao"
import { CUSTOM_DOMAIN_KINDS, enqueue } from "@lib/jobs"
import { withdrawRoute } from "@lib/lambda"
import { srnFor } from "@lib/srn"
import { db } from "@sproutos/db"
import { customDomainsEnabled, CUSTOM_DOMAINS_DISABLED_REASON } from "@utils/feature-flags"
import { Hono } from "hono"
import { describeRoute } from "hono-typebox-openapi"
import { resolver } from "hono-typebox-openapi/typebox"
import { Redis } from "ioredis"
import { getDomain } from "tldts"
import { Type } from "typebox"
import { authMiddleware } from "../middleware"
import { collectionResource, paramResource, requirePermission } from "../rbac"
import { ErrorSchemaResponse, UUID7String } from "../utils/common.serializer"
import { throwBadRequest, throwConflict, throwNotFound } from "../utils/http-exception"
import { auditContext } from "../utils/request-context"
import { validator } from "../utils/validator"
import {
  customDomainSchemaCreateRequest,
  customDomainSchemaListResponse,
  customDomainSchemaResponse,
} from "./custom-domains.serializer"

const errorResponse = {
  content: { "application/json": { schema: resolver(ErrorSchemaResponse) } },
}

const app = new Hono().use(authMiddleware)

const projectParam = Type.Object({ orgSlug: Type.String(), projectId: UUID7String })
const domainParam = Type.Object({
  orgSlug: Type.String(),
  projectId: UUID7String,
  domainId: UUID7String,
})

let valkey: Redis | undefined
function platformValkey(): Redis {
  valkey ??= new Redis(process.env.VALKEY_URL ?? "redis://localhost:41023")
  return valkey
}

export function verificationName(hostname: string): string {
  return `_sproutos-challenge.${hostname}`
}

/** Public-Suffix-List classification; private suffixes are zones to their users too. */
export function looksLikeApex(hostname: string): boolean {
  return getDomain(hostname, { allowPrivateDomains: true }) === hostname
}

function ingressHost(): string {
  return process.env.TENANT_INGRESS_HOST ?? "ingress.sproutos.run"
}

function configuredAddresses(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "")
}

type DomainPresentationRow = {
  id: string
  projectId: string
  projectName: string
  projectSlug: string
  hostname: string
  status: string
  statusReason: string | null
  isApex: boolean
  verificationToken: string
  verifiedAt: Date | null
  certificateExpiresAt: Date | null
  lastCheckedAt: Date | null
  nextRetryAt: Date | null
  createdAt: Date
}

function present(row: DomainPresentationRow) {
  const target = ingressHost()
  const traffic = row.isApex
    ? [
        {
          type: "ALIAS" as const,
          name: row.hostname,
          value: target,
          note: "Use this when your DNS provider supports apex alias or CNAME flattening.",
        },
        {
          type: "ANAME" as const,
          name: row.hostname,
          value: target,
          note: "ANAME is the equivalent name used by some DNS providers.",
        },
        ...configuredAddresses("TENANT_INGRESS_IPV4_ADDRESSES").map((address) => ({
          type: "A" as const,
          name: row.hostname,
          value: address,
          note: "Use one A record per published stable NLB address when flattening is unavailable.",
        })),
        ...configuredAddresses("TENANT_INGRESS_IPV6_ADDRESSES").map((address) => ({
          type: "AAAA" as const,
          name: row.hostname,
          value: address,
          note: "Use one AAAA record per published stable dual-stack NLB address.",
        })),
      ]
    : [
        {
          type: "CNAME" as const,
          name: row.hostname,
          value: target,
          note: "Point this hostname at the stable SproutOS tenant ingress.",
        },
      ]

  return {
    id: row.id,
    project: { id: row.projectId, name: row.projectName, slug: row.projectSlug },
    hostname: row.hostname,
    status: row.status,
    statusReason: row.statusReason,
    isApex: row.isApex,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    certificateExpiresAt: row.certificateExpiresAt?.toISOString() ?? null,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    nextRetryAt: row.nextRetryAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    instructions: {
      verification: {
        type: "TXT" as const,
        name: verificationName(row.hostname),
        value: row.verificationToken,
      },
      traffic,
    },
  }
}

async function enqueueReconciliation(organizationId: string, domainId: string): Promise<void> {
  const minute = new Date().toISOString().slice(0, 16)
  await enqueue(db, {
    kind: CUSTOM_DOMAIN_KINDS.reconcile,
    organizationId,
    payload: { domainId },
    idempotencyKey: `${CUSTOM_DOMAIN_KINDS.reconcile}:${domainId}:${minute}`,
    maxAttempts: 5,
  })
}

async function markPending(hostname: string): Promise<void> {
  await platformValkey().set(`custom-domain:pending:${hostname}`, "1", "EX", 30 * 24 * 60 * 60)
}

const routes = app
  .get(
    "/:orgSlug/domains",
    describeRoute({
      description: "Custom domains across the organization",
      responses: {
        200: {
          description: "Domains",
          content: { "application/json": { schema: resolver(customDomainSchemaListResponse) } },
        },
      },
    }),
    requirePermission("project:read", collectionResource("project", "project")),
    async (c) => {
      const rows = await fetchCustomDomain(db)
        .listInOrganizationQuery(c.var.organization.id)
        .execute()
      return c.json({ data: rows.map((row) => present(row)) })
    },
  )
  .get(
    "/:orgSlug/projects/:projectId/domains",
    describeRoute({
      description: "Custom domains attached to a project",
      responses: {
        200: {
          description: "Domains",
          content: { "application/json": { schema: resolver(customDomainSchemaListResponse) } },
        },
      },
    }),
    requirePermission("project:read", paramResource("project", "project", "projectId")),
    validator("param", projectParam),
    async (c) => {
      const { projectId } = c.req.valid("param")
      const project = await fetchProject(db).getInOrganization(c.var.organization.id, projectId, [
        "id",
        "name",
        "slug",
      ])
      if (project === undefined) return throwNotFound(c, "Project not found")
      const rows = await fetchCustomDomain(db)
        .listInProjectQuery(c.var.organization.id, projectId)
        .execute()
      return c.json({
        data: rows.map((row) =>
          present({ ...row, projectName: project.name, projectSlug: project.slug }),
        ),
      })
    },
  )
  .post(
    "/:orgSlug/projects/:projectId/domains",
    describeRoute({
      description: "Claim a hostname and return the DNS records to publish",
      responses: {
        201: {
          description: "Domain is waiting for DNS",
          content: { "application/json": { schema: resolver(customDomainSchemaResponse) } },
        },
        400: { description: "This project or hostname is not eligible", ...errorResponse },
        409: { description: "That hostname is already claimed", ...errorResponse },
      },
    }),
    requirePermission("project:update", paramResource("project", "project", "projectId")),
    validator("param", projectParam),
    validator("json", customDomainSchemaCreateRequest),
    async (c) => {
      if (!customDomainsEnabled(process.env.CUSTOM_DOMAINS_ENABLED)) {
        return c.json({ message: CUSTOM_DOMAINS_DISABLED_REASON }, 503)
      }
      const { projectId } = c.req.valid("param")
      const hostname = c.req.valid("json").hostname.toLowerCase()
      const registrable = getDomain(hostname, { allowPrivateDomains: true })
      if (registrable === null) return throwBadRequest(c, "Hostname is not a registrable domain")

      const project = await fetchProject(db).getInOrganization(c.var.organization.id, projectId, [
        "id",
        "name",
        "slug",
        "isGroup",
        "servingMode",
        "liveDeploymentId",
      ])
      if (project === undefined) return throwNotFound(c, "Project not found")
      if (project.isGroup) return throwBadRequest(c, "A project group serves no traffic")
      if (project.servingMode === "static") {
        return throwBadRequest(c, "Static custom domains are not supported yet")
      }
      if (project.liveDeploymentId === null) {
        return throwBadRequest(c, "Deploy this project before adding a custom domain")
      }

      const existing = await fetchCustomDomain(db).findLiveByHostname(hostname, ["id"])
      if (existing !== undefined) return throwConflict(c, `${hostname} is already claimed`)

      let row
      try {
        row = await db.transaction().execute(async (transaction) => {
          const created = await crudCustomDomain(transaction).create({
            organizationId: c.var.organization.id,
            projectId,
            hostname,
            isApex: looksLikeApex(hostname),
            verificationToken: `sproutos-domain-verification=${randomBytes(16).toString("hex")}`,
            status: "pending_dns",
            nextRetryAt: new Date(),
          })
          await enqueue(transaction, {
            kind: CUSTOM_DOMAIN_KINDS.reconcile,
            organizationId: c.var.organization.id,
            payload: { domainId: created.id },
            idempotencyKey: `${CUSTOM_DOMAIN_KINDS.reconcile}:${created.id}:${new Date().toISOString().slice(0, 16)}`,
            maxAttempts: 5,
          })
          await crudAuditLog(transaction).record({
            organizationId: c.var.organization.id,
            actorUserId: c.var.user.id,
            action: "project:update",
            resourceSrn: srnFor("compute", c.var.organization.id, "project", projectId),
            after: { customDomain: hostname },
            ...auditContext(c),
          })
          return created
        })
      } catch (error) {
        if ((error as { code?: unknown }).code === "23505") {
          return throwConflict(c, `${hostname} is already claimed`)
        }
        throw error
      }

      try {
        await markPending(hostname)
      } catch (error) {
        // The durable row and job are authoritative. The minute scanner retries this marker; a
        // transient cache outage must not turn a committed claim into a misleading 500 response.
        console.error("[domains] could not publish the pending-domain marker", error)
      }

      return c.json(present({ ...row, projectName: project.name, projectSlug: project.slug }), 201)
    },
  )
  .post(
    "/:orgSlug/projects/:projectId/domains/:domainId/check",
    describeRoute({
      description: "Wake asynchronous DNS and certificate reconciliation",
      responses: {
        200: {
          description: "Current state",
          content: { "application/json": { schema: resolver(customDomainSchemaResponse) } },
        },
        404: { description: "Domain not found", ...errorResponse },
      },
    }),
    requirePermission("project:update", paramResource("project", "project", "projectId")),
    validator("param", domainParam),
    async (c) => {
      if (!customDomainsEnabled(process.env.CUSTOM_DOMAINS_ENABLED)) {
        return c.json({ message: CUSTOM_DOMAINS_DISABLED_REASON }, 503)
      }
      const { projectId, domainId } = c.req.valid("param")
      const [domain, project] = await Promise.all([
        fetchCustomDomain(db).getInProject(c.var.organization.id, projectId, domainId, [
          "id",
          "projectId",
          "hostname",
          "status",
          "statusReason",
          "isApex",
          "verificationToken",
          "verifiedAt",
          "certificateExpiresAt",
          "lastCheckedAt",
          "nextRetryAt",
          "createdAt",
        ]),
        fetchProject(db).getInOrganization(c.var.organization.id, projectId, ["name", "slug"]),
      ])
      if (domain === undefined || project === undefined) return throwNotFound(c, "Domain not found")
      await Promise.all([
        crudCustomDomain(db).update(c.var.organization.id, domainId, { nextRetryAt: new Date() }),
        markPending(domain.hostname),
        enqueueReconciliation(c.var.organization.id, domainId),
      ])
      return c.json(present({ ...domain, projectName: project.name, projectSlug: project.slug }))
    },
  )
  .delete(
    "/:orgSlug/projects/:projectId/domains/:domainId",
    describeRoute({
      description: "Stop serving and asynchronously release a custom domain",
      responses: {
        204: { description: "Deletion started" },
        404: { description: "Domain not found", ...errorResponse },
      },
    }),
    requirePermission("project:update", paramResource("project", "project", "projectId")),
    validator("param", domainParam),
    async (c) => {
      const { projectId, domainId } = c.req.valid("param")
      const domain = await fetchCustomDomain(db).getInProject(
        c.var.organization.id,
        projectId,
        domainId,
        ["id", "hostname"],
      )
      if (domain === undefined) return throwNotFound(c, "Domain not found")

      const deleting = await db.transaction().execute(async (transaction) => {
        const claimed = await crudCustomDomain(transaction).beginDelete(
          c.var.organization.id,
          domainId,
        )
        if (claimed === undefined) return undefined
        await enqueue(transaction, {
          kind: CUSTOM_DOMAIN_KINDS.reconcile,
          organizationId: c.var.organization.id,
          payload: { domainId },
          idempotencyKey: `${CUSTOM_DOMAIN_KINDS.reconcile}:${domainId}:${new Date().toISOString().slice(0, 16)}`,
          maxAttempts: 5,
        })
        await crudAuditLog(transaction).record({
          organizationId: c.var.organization.id,
          actorUserId: c.var.user.id,
          action: "project:update",
          resourceSrn: srnFor("compute", c.var.organization.id, "project", projectId),
          before: { customDomain: domain.hostname },
          ...auditContext(c),
        })
        return claimed
      })
      if (deleting === undefined) return throwNotFound(c, "Domain not found")
      await withdrawRoute(platformValkey(), domain.hostname)
      await platformValkey().del(`custom-domain:pending:${domain.hostname}`)
      return c.body(null, 204)
    },
  )

export default routes
