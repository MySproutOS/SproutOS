import { crudAgentConfig, crudAgentCredential, crudAuditLog, fetchAgentConfig } from "@lib/dao"
import { srnFor } from "@lib/srn"
import { seal } from "@lib/envelope"
import { credentialContext, resolveAgentCredential } from "@lib/agent"
import { db } from "@sproutos/db"
import { Hono } from "hono"
import { describeRoute } from "hono-typebox-openapi"
import { resolver, validator } from "hono-typebox-openapi/typebox"
import { v7 } from "uuid"
import { authMiddleware } from "../middleware"
import { requirePermission } from "../rbac"
import { EmptyObject, ErrorSchemaResponse } from "../utils/common.serializer"
import { ErrorCode } from "../utils/errors.enum"
import { throwBadRequest, throwNotFound } from "../utils/http-exception"
import { auditContext } from "../utils/request-context"
import {
  agentSchemaConfig,
  agentSchemaConfigUpdateRequest,
  agentSchemaCredentialCreateRequest,
  agentSchemaCredentialIdParam,
  agentSchemaCredentialListResponse,
} from "./agent.serializer"

const errorResponse = {
  content: { "application/json": { schema: resolver(ErrorSchemaResponse) } },
}

/** The tail of a key, so a person can tell two of them apart. Never enough to use. */
function lastFourOf(secret: string): string | null {
  const trimmed = secret.trim()
  return trimmed.length >= 8 ? trimmed.slice(-4) : null
}

const app = new Hono()
  .use(authMiddleware)
  .get(
    "/:orgSlug/agent/credentials",
    describeRoute({
      description: "Lists the organization's model credentials, without their secrets",
      responses: {
        200: {
          description: "Credentials",
          content: {
            "application/json": { schema: resolver(agentSchemaCredentialListResponse) },
          },
        },
        403: { description: "Caller may not read credentials", ...errorResponse },
      },
    }),
    requirePermission("credential:read"),
    async (c) => {
      const rows = await db
        .selectFrom("agentCredential")
        .select([
          "id",
          "kind",
          "label",
          "lastFour",
          "baseUrl",
          "expiresAt",
          "lastVerifiedAt",
          "revokedAt",
          "createdAt",
        ])
        .where("organizationId", "=", c.var.organization.id)
        .where("deletedAt", "is", null)
        .orderBy("createdAt", "desc")
        .execute()

      return c.json({
        data: rows.map((row) => ({
          ...row,
          expiresAt: row.expiresAt?.toISOString() ?? null,
          lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
          revokedAt: row.revokedAt?.toISOString() ?? null,
          createdAt: row.createdAt.toISOString(),
        })),
      })
    },
  )
  .post(
    "/:orgSlug/agent/credentials",
    describeRoute({
      description: "Stores a model credential, encrypted, and returns everything but the secret",
      responses: {
        201: {
          description: "Stored",
          content: { "application/json": { schema: resolver(agentSchemaCredentialListResponse) } },
        },
        400: { description: "Label already used", ...errorResponse },
        403: { description: "Caller may not write credentials", ...errorResponse },
      },
    }),
    requirePermission("credential:write"),
    validator("json", agentSchemaCredentialCreateRequest),
    async (c) => {
      const body = c.req.valid("json")
      const organization = c.var.organization
      const secret = body.secret.trim()
      if (secret === "") return throwBadRequest(c, "secret is empty")

      // The id is chosen before the seal, because it is part of the encryption context — the
      // ciphertext is bound to the row it is about to live in.
      const credentialId = v7()
      const sealed = await seal(secret, credentialContext(organization.id, credentialId))

      try {
        const created = await crudAgentCredential(db).createCredential({
          id: credentialId,
          organizationId: organization.id,
          kind: body.kind,
          label: body.label,
          secretCiphertext: sealed.ciphertext,
          secretWrappedDek: sealed.wrappedDek,
          secretKmsKeyId: sealed.kmsKeyId,
          lastFour: lastFourOf(secret),
          baseUrl: body.baseUrl ?? null,
          expiresAt:
            body.expiresAt === undefined || body.expiresAt === null
              ? null
              : new Date(body.expiresAt),
        })

        /*
          Select it, when nothing else is selected.

          `resolveAgentCredential` reads `agent_config.agent_credential_id`; adding a credential
          used to leave that null, so a customer could store their key, see it listed, and have
          agent chat still answer `No model credential configured (no_config)`. Adding a credential
          and choosing one were two separate actions and only one of them had a UI.

          Only when there is no config yet. An organization that has deliberately pointed at
          another credential must not be switched by someone adding a second one — that would
          silently move their agent runs onto a different key and, for a metered kind, a different
          bill.
        */
        const existingConfig = await fetchAgentConfig(db).getForOrganization(organization.id, [
          "id",
        ])
        if (existingConfig === undefined) {
          await crudAgentConfig(db).upsertForOrganization(organization.id, {
            agentCredentialId: created.id,
          })
        }

        await crudAuditLog(db).record({
          organizationId: organization.id,
          actorUserId: c.var.user.id,
          action: "credential:write",
          resourceSrn: srnFor("agent", organization.id, "credential", created.id),
          // Records that a credential was added and which one — never the secret, and never
          // enough of it to matter.
          after: { kind: body.kind, label: body.label, lastFour: created.lastFour },
          ...auditContext(c),
        })

        return c.json(
          {
            data: [
              {
                id: created.id,
                kind: created.kind as (typeof body)["kind"],
                label: created.label,
                lastFour: created.lastFour,
                baseUrl: created.baseUrl,
                expiresAt: created.expiresAt?.toISOString() ?? null,
                lastVerifiedAt: null,
                revokedAt: null,
                createdAt: created.createdAt.toISOString(),
              },
            ],
          },
          201,
        )
      } catch (error) {
        // agent_credential_label_live_key: one live label per organization, so a list stays
        // readable and "the OpenAI one" means something.
        if (String(error).includes("agent_credential_label_live_key")) {
          return throwBadRequest(
            c,
            "A credential with that label already exists",
            ErrorCode.ResourceAlreadyExists,
          )
        }
        throw error
      }
    },
  )
  .delete(
    "/:orgSlug/agent/credentials/:credentialId",
    describeRoute({
      description: "Revokes a credential. Runs configured to use it stop rather than fall back",
      responses: {
        200: {
          description: "Revoked",
          content: { "application/json": { schema: resolver(EmptyObject) } },
        },
        403: { description: "Caller may not write credentials", ...errorResponse },
        404: { description: "No such credential", ...errorResponse },
      },
    }),
    requirePermission("credential:write"),
    validator("param", agentSchemaCredentialIdParam),
    async (c) => {
      const { credentialId } = c.req.valid("param")
      const organization = c.var.organization

      const revoked = await crudAgentCredential(db).revokeCredential(organization.id, credentialId)
      if (!revoked) return throwNotFound(c, "Credential not found")

      await crudAuditLog(db).record({
        organizationId: organization.id,
        actorUserId: c.var.user.id,
        action: "credential:write",
        resourceSrn: srnFor("agent", organization.id, "credential", credentialId),
        after: { revoked: true },
        ...auditContext(c),
      })

      return c.json({})
    },
  )
  .get(
    "/:orgSlug/agent/config",
    describeRoute({
      description: "Reads the organization's agent configuration and what a run would do now",
      responses: {
        200: {
          description: "Configuration",
          content: { "application/json": { schema: resolver(agentSchemaConfig) } },
        },
        403: { description: "Caller may not read credentials", ...errorResponse },
      },
    }),
    requirePermission("credential:read"),
    async (c) => {
      const organization = c.var.organization
      const config = await fetchAgentConfig(db).getForOrganization(organization.id, [
        "agentCredentialId",
        "useSproutosCredits",
        "model",
        "maxBudgetMicroUsd",
        "permissionMode",
      ])

      // Resolved rather than inferred client-side. The precedence rules — a named credential wins
      // over credits, a revoked one falls to nothing rather than to credits — live in one place,
      // and a UI that re-derived them would eventually disagree with what actually runs.
      const resolved = await resolveAgentCredential(db, organization.id)

      return c.json({
        agentCredentialId: config?.agentCredentialId ?? null,
        useSproutosCredits: config?.useSproutosCredits ?? false,
        model: config?.model ?? null,
        maxBudgetMicroUsd:
          config?.maxBudgetMicroUsd === undefined || config.maxBudgetMicroUsd === null
            ? null
            : String(config.maxBudgetMicroUsd),
        permissionMode: (config?.permissionMode ?? "default") as "default",
        effectiveBilling: resolved.billing,
      })
    },
  )
  .put(
    "/:orgSlug/agent/config",
    describeRoute({
      description: "Saves the organization's agent configuration",
      responses: {
        200: {
          description: "Saved",
          content: { "application/json": { schema: resolver(agentSchemaConfig) } },
        },
        400: { description: "Credential does not belong to this organization", ...errorResponse },
        403: { description: "Caller may not write credentials", ...errorResponse },
      },
    }),
    requirePermission("credential:write"),
    validator("json", agentSchemaConfigUpdateRequest),
    async (c) => {
      const body = c.req.valid("json")
      const organization = c.var.organization
      const config = await fetchAgentConfig(db).getForOrganization(organization.id, [
        "agentCredentialId",
        "useSproutosCredits",
      ])

      if (body.agentCredentialId !== undefined && body.agentCredentialId !== null) {
        // Checked here rather than left to the foreign key: the FK only proves the credential
        // exists, not that it belongs to the caller's organization.
        const owned = await db
          .selectFrom("agentCredential")
          .select("id")
          .where("id", "=", body.agentCredentialId)
          .where("organizationId", "=", organization.id)
          .where("deletedAt", "is", null)
          .where("revokedAt", "is", null)
          .executeTakeFirst()

        if (owned === undefined) {
          return throwBadRequest(c, "That credential does not belong to this organization")
        }
      }

      const saved = await crudAgentConfig(db).upsertForOrganization(organization.id, {
        ...(body.agentCredentialId === undefined
          ? {}
          : { agentCredentialId: body.agentCredentialId }),
        ...(body.useSproutosCredits === undefined
          ? {}
          : { useSproutosCredits: body.useSproutosCredits }),
        ...(body.model === undefined ? {} : { model: body.model }),
        ...(body.maxBudgetMicroUsd === undefined
          ? {}
          : {
              maxBudgetMicroUsd:
                body.maxBudgetMicroUsd === null ? null : BigInt(body.maxBudgetMicroUsd),
            }),
        ...(body.permissionMode === undefined ? {} : { permissionMode: body.permissionMode }),
      })

      await crudAuditLog(db).record({
        organizationId: organization.id,
        actorUserId: c.var.user.id,
        action: "credential:write",
        resourceSrn: srnFor("agent", organization.id, "config", saved.id),
        // Worth auditing precisely because it decides who pays: turning credits on is a standing
        // authorization to spend a balance.
        before: {
          agentCredentialId: config?.agentCredentialId ?? null,
          useSproutosCredits: config?.useSproutosCredits ?? false,
        },
        after: {
          agentCredentialId: saved.agentCredentialId,
          useSproutosCredits: saved.useSproutosCredits,
        },
        ...auditContext(c),
      })

      const resolved = await resolveAgentCredential(db, organization.id)

      return c.json({
        agentCredentialId: saved.agentCredentialId,
        useSproutosCredits: saved.useSproutosCredits,
        model: saved.model,
        maxBudgetMicroUsd:
          saved.maxBudgetMicroUsd === null ? null : String(saved.maxBudgetMicroUsd),
        permissionMode: saved.permissionMode as "default",
        effectiveBilling: resolved.billing,
      })
    },
  )

export default app
