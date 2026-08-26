import { randomBytes } from "node:crypto"
import { resolveTxt } from "node:dns/promises"
import {
  ACMClient,
  DeleteCertificateCommand,
  DescribeCertificateCommand,
  RequestCertificateCommand,
} from "@aws-sdk/client-acm"
import {
  AddListenerCertificatesCommand,
  ElasticLoadBalancingV2Client,
  RemoveListenerCertificatesCommand,
} from "@aws-sdk/client-elastic-load-balancing-v2"
import { crudAuditLog } from "@lib/dao"
import { publishRoute, type Route, withdrawRoute } from "@lib/lambda"
import { srnFor } from "@lib/srn"
import { db } from "@sproutos/db"
import { Hono } from "hono"
import { describeRoute } from "hono-typebox-openapi"
import { resolver } from "hono-typebox-openapi/typebox"
import { Redis } from "ioredis"
import { Type } from "typebox"
import { v7 } from "uuid"
import { authMiddleware } from "../middleware"
import { paramResource, requirePermission } from "../rbac"
import { ErrorSchemaResponse, UUID7String } from "../utils/common.serializer"
import { throwBadRequest, throwNotFound } from "../utils/http-exception"
import { auditContext } from "../utils/request-context"
import { validator } from "../utils/validator"
import {
  customDomainSchemaCreateRequest,
  customDomainSchemaListResponse,
  customDomainSchemaResponse,
} from "./custom-domains.serializer"

/**
 * A customer's own hostname, pointed at their project.
 *
 * ADR 0022 calls the generated hostname "a string most customers will replace with a custom
 * domain", and ADR 0018 says custom domains are CNAMEs onto the tenant ingress. Neither had an
 * implementation.
 *
 * ## Three records, and the order they happen in
 *
 * 1. **A TXT proving control of the zone.** Anyone can point a hostname at our load balancer;
 *    that must not be enough to make us serve it. Without this, one tenant could claim a hostname
 *    another tenant owns and take their traffic the moment DNS moved.
 * 2. **A CNAME ACM asks for**, so the certificate can issue. Nothing here can shortcut it — the
 *    customer controls the zone, which is the entire point of step 1.
 * 3. **The traffic record itself**, A for an apex and CNAME for anything else. An apex cannot hold
 *    a CNAME; that is DNS and not something we can work around.
 *
 * Verification and issuance are checked on demand rather than polled, because both are things the
 * *customer* has to act on and the natural moment to look is when they come back and press the
 * button.
 */

const errorResponse = {
  content: { "application/json": { schema: resolver(ErrorSchemaResponse) } },
}

const app = new Hono().use(authMiddleware)

const domainParam = Type.Object({
  orgSlug: Type.String(),
  projectId: UUID7String,
  domainId: UUID7String,
})

function acm(): ACMClient {
  return new ACMClient({ region: process.env.AWS_REGION ?? "us-east-1" })
}

function elb(): ElasticLoadBalancingV2Client {
  return new ElasticLoadBalancingV2Client({ region: process.env.AWS_REGION ?? "us-east-1" })
}

let valkey: Redis | undefined
function platformValkey(): Redis {
  valkey ??= new Redis(process.env.VALKEY_URL ?? "redis://localhost:41023")
  return valkey
}

/**
 * Whether a hostname is a zone apex.
 *
 * Counting dots is wrong for every multi-label public suffix — `example.co.uk` is an apex and has
 * two dots, exactly like `www.example.com` which is not. Without the full Public Suffix List this
 * cannot be answered perfectly, so the heuristic is deliberate and its consequence is mild: the
 * only thing it changes is which record we *tell* the customer to create, and a customer told to
 * make a CNAME at an apex will be refused by their own DNS provider with a clear message.
 */
export function looksLikeApex(hostname: string): boolean {
  const labels = hostname.split(".")
  if (labels.length <= 2) return true

  const MULTI_LABEL_SUFFIXES = new Set(["co.uk", "com.au", "co.nz", "co.jp", "com.br", "co.za"])
  return labels.length === 3 && MULTI_LABEL_SUFFIXES.has(labels.slice(-2).join("."))
}

/** The name the verification TXT is published at. */
export function verificationName(hostname: string): string {
  return `_sproutos-challenge.${hostname}`
}

function ingressHost(): string {
  return process.env.TENANT_INGRESS_HOST ?? `ingress.${process.env.TENANT_DOMAIN ?? "sproutos.run"}`
}

type DomainRow = {
  id: string
  hostname: string
  status: string
  statusReason: string | null
  isApex: boolean
  verificationToken: string
  acmValidationName: string | null
  acmValidationValue: string | null
  verifiedAt: Date | null
  createdAt: Date
}

function present(row: DomainRow) {
  return {
    id: row.id,
    hostname: row.hostname,
    status: row.status,
    statusReason: row.statusReason,
    isApex: row.isApex,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    instructions: {
      verification: {
        type: "TXT" as const,
        name: verificationName(row.hostname),
        value: row.verificationToken,
      },
      certificate:
        row.acmValidationName === null || row.acmValidationValue === null
          ? null
          : {
              type: "CNAME" as const,
              name: row.acmValidationName,
              value: row.acmValidationValue,
            },
      traffic: row.isApex
        ? {
            type: "A" as const,
            name: row.hostname,
            value: process.env.TENANT_INGRESS_IPS ?? "",
            note:
              "An apex cannot hold a CNAME, so this must be an A record — or an ALIAS/ANAME if " +
              "your DNS provider offers one, which is preferable because our addresses can change.",
          }
        : {
            type: "CNAME" as const,
            name: row.hostname,
            value: ingressHost(),
            note: "Point this at the SproutOS ingress. It does not change.",
          },
    },
  }
}

/** The project, scoped to the caller's organization. A group is refused: it serves nothing. */
async function liveProject(organizationId: string, projectId: string) {
  return await db
    .selectFrom("project")
    .select(["id", "isGroup", "liveDeploymentId"])
    .where("id", "=", projectId)
    .where("organizationId", "=", organizationId)
    .where("deletedAt", "is", null)
    .executeTakeFirst()
}

const routes = app
  .get(
    "/:orgSlug/projects/:projectId/domains",
    describeRoute({
      description: "The custom domains attached to a project, and what to publish for each",
      responses: {
        200: {
          description: "Domains",
          content: { "application/json": { schema: resolver(customDomainSchemaListResponse) } },
        },
      },
    }),
    requirePermission("project:read", paramResource("project", "project", "projectId")),
    async (c) => {
      const rows = await db
        .selectFrom("customDomain")
        .selectAll()
        .where("projectId", "=", c.req.param("projectId"))
        .where("organizationId", "=", c.var.organization.id)
        .where("deletedAt", "is", null)
        .orderBy("createdAt", "asc")
        .execute()

      return c.json({ data: rows.map(present) })
    },
  )
  .post(
    "/:orgSlug/projects/:projectId/domains",
    describeRoute({
      description: "Attach a hostname to a project. Returns the records to publish.",
      responses: {
        201: {
          description: "Added, pending verification",
          content: { "application/json": { schema: resolver(customDomainSchemaResponse) } },
        },
        400: { description: "A group cannot serve a domain", ...errorResponse },
        409: { description: "That hostname is already claimed", ...errorResponse },
      },
    }),
    requirePermission("project:update", paramResource("project", "project", "projectId")),
    validator("json", customDomainSchemaCreateRequest),
    async (c) => {
      const projectId = c.req.param("projectId")
      const hostname = c.req.valid("json").hostname.toLowerCase()

      const project = await liveProject(c.var.organization.id, projectId)
      if (project === undefined) return throwNotFound(c, "Project not found")
      if (project.isGroup) {
        return throwBadRequest(
          c,
          "A project group holds other projects and serves no traffic, so it cannot have a domain. " +
            "Attach it to one of its projects instead.",
        )
      }

      /*
        One live claim per hostname across the platform, enforced by a unique index.

        Checked here as well so the answer is a sentence rather than a constraint violation, but the
        index is what makes it true — two requests racing would both pass this check.
      */
      const existing = await db
        .selectFrom("customDomain")
        .select(["id", "projectId"])
        .where("hostname", "=", hostname)
        .where("deletedAt", "is", null)
        .executeTakeFirst()

      if (existing !== undefined) {
        return c.json(
          {
            message:
              existing.projectId === projectId
                ? `${hostname} is already attached to this project.`
                : `${hostname} is already attached to another project.`,
          },
          409,
        )
      }

      const isApex = looksLikeApex(hostname)

      /*
        The certificate is requested now, not at verification.

        ACM's own validation record is the slowest part of this for a customer — they have to go to
        their DNS provider anyway — so asking for both records in one visit is the difference
        between one trip and two. The certificate simply sits `PENDING_VALIDATION` until they do.
      */
      let certificateArn: string | null = null
      let validationName: string | null = null
      let validationValue: string | null = null

      try {
        const requested = await acm().send(
          new RequestCertificateCommand({
            DomainName: hostname,
            ValidationMethod: "DNS",
            Tags: [
              { Key: "sproutos:project", Value: projectId },
              { Key: "sproutos:organization", Value: c.var.organization.id },
            ],
          }),
        )
        certificateArn = requested.CertificateArn ?? null

        /*
          ACM populates the validation record asynchronously, so the first describe usually has
          nothing. Polled briefly rather than left null: a customer who has to press "check" once
          before being told what to publish will reasonably assume it is broken.
        */
        for (let attempt = 0; attempt < 5 && validationName === null; attempt++) {
          const described = await acm().send(
            new DescribeCertificateCommand({ CertificateArn: certificateArn ?? "" }),
          )
          const option = described.Certificate?.DomainValidationOptions?.[0]?.ResourceRecord
          if (option?.Name !== undefined && option.Value !== undefined) {
            validationName = option.Name
            validationValue = option.Value
          } else {
            await new Promise((resolve) => setTimeout(resolve, 1000))
          }
        }
      } catch (cause) {
        // A certificate we could not request is not a reason to lose the domain the customer just
        // added. It is recorded as pending with a reason, and re-requested on verify.
        console.error("[domains] certificate request failed", cause)
      }

      const row = await db
        .insertInto("customDomain")
        .values({
          id: v7(),
          organizationId: c.var.organization.id,
          projectId,
          hostname,
          isApex,
          // 32 hex characters. Long enough that guessing is not a strategy, short enough to retype.
          verificationToken: `sproutos-domain-verification=${randomBytes(16).toString("hex")}`,
          acmCertificateArn: certificateArn,
          acmValidationName: validationName,
          acmValidationValue: validationValue,
          status: "pending",
        })
        .returningAll()
        .executeTakeFirstOrThrow()

      await crudAuditLog(db).record({
        organizationId: c.var.organization.id,
        actorUserId: c.var.user.id,
        action: "project:update",
        resourceSrn: srnFor("compute", c.var.organization.id, "project", projectId),
        after: { customDomain: hostname },
        ...auditContext(c),
      })

      return c.json(present(row), 201)
    },
  )
  .post(
    "/:orgSlug/projects/:projectId/domains/:domainId/verify",
    describeRoute({
      description: "Check the published records and, if they are right, start serving the domain",
      responses: {
        200: {
          description: "The domain's state after checking",
          content: { "application/json": { schema: resolver(customDomainSchemaResponse) } },
        },
        404: { description: "No such domain on this project", ...errorResponse },
      },
    }),
    requirePermission("project:update", paramResource("project", "project", "projectId")),
    validator("param", domainParam),
    async (c) => {
      const { projectId, domainId } = c.req.valid("param")

      const domain = await db
        .selectFrom("customDomain")
        .selectAll()
        .where("id", "=", domainId)
        .where("projectId", "=", projectId)
        .where("organizationId", "=", c.var.organization.id)
        .where("deletedAt", "is", null)
        .executeTakeFirst()

      if (domain === undefined) return throwNotFound(c, "Domain not found")

      /*
        Step 1 — do they control the zone?

        `resolveTxt` returns arrays of strings because a TXT record can be split into chunks; they
        are joined before comparison, or a token that crossed the 255-byte boundary would never
        match. Ours is short enough that it will not, which is exactly the kind of assumption that
        stops being true after someone changes the token format.
      */
      let verified = false
      try {
        const records = await resolveTxt(verificationName(domain.hostname))
        verified = records.some((chunks) => chunks.join("") === domain.verificationToken)
      } catch {
        verified = false
      }

      if (!verified) {
        await db
          .updateTable("customDomain")
          .set({
            status: "verifying",
            statusReason:
              `No matching TXT record at ${verificationName(domain.hostname)} yet. ` +
              `DNS changes can take a few minutes to publish.`,
            updatedAt: new Date(),
          })
          .where("id", "=", domainId)
          .execute()

        const after = { ...domain, status: "verifying" }
        return c.json(present(after))
      }

      // Step 2 — has the certificate issued?
      let certificateReady = false
      if (domain.acmCertificateArn !== null) {
        try {
          const described = await acm().send(
            new DescribeCertificateCommand({ CertificateArn: domain.acmCertificateArn }),
          )
          certificateReady = described.Certificate?.Status === "ISSUED"
        } catch (cause) {
          console.error("[domains] certificate describe failed", cause)
        }
      }

      if (!certificateReady) {
        await db
          .updateTable("customDomain")
          .set({
            status: "issuing",
            statusReason:
              "Ownership is verified. The certificate has not issued yet — check the CNAME record " +
              "above is published exactly as shown.",
            verifiedAt: new Date(),
            updatedAt: new Date(),
          })
          .where("id", "=", domainId)
          .execute()

        return c.json(present({ ...domain, status: "issuing", verifiedAt: new Date() }))
      }

      /*
        Step 3 — make it serve.

        The certificate goes on the listener so TLS works for this name, and the route goes into
        Valkey so the router knows where to send it. Both are needed and neither is sufficient: a
        certificate with no route is a valid handshake followed by a 404, and a route with no
        certificate is a connection the browser refuses before we ever see it.
      */
      const listenerArn = process.env.TENANT_LISTENER_ARN
      if (listenerArn !== undefined && listenerArn !== "") {
        await elb().send(
          new AddListenerCertificatesCommand({
            ListenerArn: listenerArn,
            Certificates: [{ CertificateArn: domain.acmCertificateArn ?? "" }],
          }),
        )
      }

      /*
        The route is copied from the project's live deployment.

        A domain attached to a project that has never deployed is verified and issued but has
        nothing to point at. It becomes `active` anyway and the next release publishes it — see
        `publish.ts`, which republishes every active domain — because the alternative is telling a
        customer their correctly-configured domain "failed" when the only thing missing is a deploy
        they already know they have not done.
      */
      const live =
        (await db
          .selectFrom("deployment")
          .innerJoin("project", "project.liveDeploymentId", "deployment.id")
          .select([
            "deployment.id as deploymentId",
            "project.id as projectId",
            "project.organizationId as organizationId",
          ])
          .where("project.id", "=", projectId)
          .where("deployment.deletedAt", "is", null)
          .executeTakeFirst()) ?? undefined

      if (live !== undefined) {
        const arn = await db
          .selectFrom("deployment")
          .select("lambdaVersion")
          .where("id", "=", live.deploymentId)
          .executeTakeFirst()

        if (arn !== undefined) {
          const route: Route = {
            arn: `arn:aws:lambda:${process.env.AWS_REGION ?? "us-east-1"}:${process.env.AWS_ACCOUNT_ID ?? ""}:function:sproutos-app-${projectId}:live`,
            projectId,
            organizationId: c.var.organization.id,
            deploymentId: live.deploymentId,
          }
          await publishRoute(platformValkey(), domain.hostname, route)
        }
      }

      await db
        .updateTable("customDomain")
        .set({
          status: "active",
          statusReason: null,
          verifiedAt: domain.verifiedAt ?? new Date(),
          updatedAt: new Date(),
        })
        .where("id", "=", domainId)
        .execute()

      return c.json(present({ ...domain, status: "active", verifiedAt: new Date() }))
    },
  )
  .delete(
    "/:orgSlug/projects/:projectId/domains/:domainId",
    describeRoute({
      description: "Stop serving a domain and release its certificate",
      responses: {
        204: { description: "Removed" },
        404: { description: "No such domain on this project", ...errorResponse },
      },
    }),
    requirePermission("project:update", paramResource("project", "project", "projectId")),
    validator("param", domainParam),
    async (c) => {
      const { projectId, domainId } = c.req.valid("param")

      const domain = await db
        .selectFrom("customDomain")
        .selectAll()
        .where("id", "=", domainId)
        .where("projectId", "=", projectId)
        .where("organizationId", "=", c.var.organization.id)
        .where("deletedAt", "is", null)
        .executeTakeFirst()

      if (domain === undefined) return throwNotFound(c, "Domain not found")

      /*
        Route first, then certificate.

        The other order leaves a window where the hostname still resolves here and TLS no longer
        works, which a visitor sees as a security warning rather than a 404 — a considerably worse
        way to discover a domain was removed.
      */
      await withdrawRoute(platformValkey(), domain.hostname)

      const listenerArn = process.env.TENANT_LISTENER_ARN
      if (listenerArn !== undefined && listenerArn !== "" && domain.acmCertificateArn !== null) {
        try {
          await elb().send(
            new RemoveListenerCertificatesCommand({
              ListenerArn: listenerArn,
              Certificates: [{ CertificateArn: domain.acmCertificateArn }],
            }),
          )
          await acm().send(
            new DeleteCertificateCommand({ CertificateArn: domain.acmCertificateArn }),
          )
        } catch (cause) {
          // A certificate that could not be released is a cost, not a correctness problem, and the
          // customer's request has already been honoured — the domain stopped serving above.
          console.error("[domains] certificate cleanup failed", cause)
        }
      }

      await db
        .updateTable("customDomain")
        .set({ deletedAt: new Date(), updatedAt: new Date(), status: "pending" })
        .where("id", "=", domainId)
        .execute()

      await crudAuditLog(db).record({
        organizationId: c.var.organization.id,
        actorUserId: c.var.user.id,
        action: "project:update",
        resourceSrn: srnFor("compute", c.var.organization.id, "project", projectId),
        before: { customDomain: domain.hostname },
        ...auditContext(c),
      })

      return c.body(null, 204)
    },
  )

export default routes
