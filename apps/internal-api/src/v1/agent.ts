import { crudAgentConfig, crudAgentCredential, crudAuditLog, fetchAgentConfig } from "@lib/dao"
import { srnFor } from "@lib/srn"
import { seal } from "@lib/envelope"
import {
  credentialContext,
  type MintedProxyToken,
  mintProxyToken,
  refreshProxyToken,
  upstreamKindFor,
  RefreshRejectedError,
  resolveAgentCredential,
} from "@lib/agent"
import { sealForProxy } from "@lib/proxy-secret"
import { db } from "@sproutos/db"
import { Hono } from "hono"
import { describeRoute } from "hono-typebox-openapi"
import { resolver } from "hono-typebox-openapi/typebox"
import { validator } from "../utils/validator"
import { v7 } from "uuid"
import { authMiddleware } from "../middleware"
import { requirePermission } from "../rbac"
import { EmptyObject, ErrorSchemaResponse } from "../utils/common.serializer"
import { ErrorCode } from "../utils/errors.enum"
import { throwBadRequest, throwNotFound } from "../utils/http-exception"
import { auditContext } from "../utils/request-context"
import {
  AGENT_CREDENTIAL_KINDS,
  agentSchemaProxyRefreshRequest,
  agentSchemaProxyTokenRequest,
  agentSchemaProxyTokenResponse,
  agentSchemaConfig,
  agentSchemaConfigUpdateRequest,
  agentSchemaCredential,
  agentSchemaCredentialCreateRequest,
  agentSchemaCredentialUpdateRequest,
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
  .patch(
    "/:orgSlug/agent/credentials/:credentialId",
    describeRoute({
      description: "Changes a model credential's display label without replacing its secret",
      responses: {
        200: {
          description: "Updated credential metadata",
          content: { "application/json": { schema: resolver(agentSchemaCredential) } },
        },
        400: { description: "Label already used", ...errorResponse },
        403: { description: "Caller may not write credentials", ...errorResponse },
        404: { description: "No such live credential", ...errorResponse },
      },
    }),
    requirePermission("credential:write"),
    validator("param", agentSchemaCredentialIdParam),
    validator("json", agentSchemaCredentialUpdateRequest),
    async (c) => {
      const { credentialId } = c.req.valid("param")
      const label = c.req.valid("json").label.trim()
      if (label === "") return throwBadRequest(c, "label is empty")

      try {
        const updated = await crudAgentCredential(db).updateLabel(
          c.var.organization.id,
          credentialId,
          label,
        )
        if (updated === undefined) return throwNotFound(c, "Credential not found")

        await crudAuditLog(db).record({
          organizationId: c.var.organization.id,
          actorUserId: c.var.user.id,
          action: "credential:write",
          resourceSrn: srnFor("agent", c.var.organization.id, "credential", credentialId),
          after: { label },
          ...auditContext(c),
        })

        return c.json({
          id: updated.id,
          kind: updated.kind as (typeof AGENT_CREDENTIAL_KINDS)[number],
          label: updated.label,
          lastFour: updated.lastFour,
          baseUrl: updated.baseUrl,
          expiresAt: updated.expiresAt?.toISOString() ?? null,
          lastVerifiedAt: updated.lastVerifiedAt?.toISOString() ?? null,
          revokedAt: updated.revokedAt?.toISOString() ?? null,
          createdAt: updated.createdAt.toISOString(),
        })
      } catch (error) {
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

/**
 * Mint the credential a sandbox agent runs with.
 *
 * The agent gets one of these and never a model provider's key. `CreateSandboxInput.env` has said
 * so since it was written; this is what finally makes it possible, because until now there was
 * nothing else to give it.
 *
 * The upstream credential is resolved and sealed **here**, once, so the router can open exactly
 * this session and nothing else. Sealing it at mint time also means a customer who rotates their
 * key keeps working until the token expires, rather than having a turn change providers halfway
 * through in a way nobody could explain.
 */
const proxyTokens = new Hono()
  .use(authMiddleware)
  .post(
    "/:orgSlug/agent/proxy-token",
    describeRoute({
      description: "Mint an access/refresh pair for a sandbox agent to reach the LLM proxy",
      responses: {
        201: {
          description: "The pair. Both values are returned once and are not recoverable",
          content: { "application/json": { schema: resolver(agentSchemaProxyTokenResponse) } },
        },
        409: {
          description: "This organization has no usable model credential",
          ...ErrorSchemaResponse,
        },
      },
    }),
    requirePermission("credential:read"),
    validator("json", agentSchemaProxyTokenRequest),
    async (c) => {
      const organization = c.var.organization
      const body = c.req.valid("json")

      const resolved = await resolveAgentCredential(db, organization.id)
      if (resolved.billing === "none") {
        return throwBadRequest(
          c,
          "This organization has no model credential configured, and no credit to fall back on. " +
            "Add one in Settings before starting an agent.",
        )
      }

      /*
        A byo credential is sealed for the proxy; a platform-billed run carries nothing.

        The platform's own key lives in the router's environment. Copying it into every token row
        would multiply the places a rotation has to reach by the number of live sandboxes, for no
        gain — it is one credential for the whole platform either way.
      */
      const upstream =
        resolved.billing === "byo"
          ? {
              upstreamBaseUrl: resolved.baseUrl,
              upstreamKind: upstreamKindFor(resolved.kind),
              upstreamSecret: sealForProxy(resolved.secret),
            }
          : { upstreamBaseUrl: null, upstreamKind: null, upstreamSecret: null }

      const minted = await mintProxyToken(db, {
        agentCredentialId: resolved.billing === "byo" ? resolved.credentialId : null,
        organizationId: organization.id,
        projectId: body.projectId ?? null,
        ...upstream,
      })

      /*
        Audited, and the audit names no token.

        `audit_log` is append-only, so a token written into it would be a live credential that
        literally cannot be deleted. The same rule the env-var route already follows.
      */
      await crudAuditLog(db).record({
        action: "credential:read",
        actorUserId: c.var.user.id,
        after: { billing: resolved.billing, projectId: body.projectId ?? null, proxyToken: true },
        organizationId: organization.id,
        resourceSrn: srnFor("agent", organization.id, "proxy-token", minted.id),
        ...auditContext(c),
      })

      return c.json(present(minted), 201)
    },
  )
  .post(
    "/:orgSlug/agent/proxy-token/refresh",
    describeRoute({
      description: "Exchange a refresh token for a new pair",
      responses: {
        200: {
          description: "A new pair. The old refresh token stops working",
          content: { "application/json": { schema: resolver(agentSchemaProxyTokenResponse) } },
        },
        401: { description: "That refresh token is not usable", ...ErrorSchemaResponse },
      },
    }),
    requirePermission("credential:read"),
    validator("json", agentSchemaProxyRefreshRequest),
    async (c) => {
      try {
        return c.json(present(await refreshProxyToken(db, c.req.valid("json").refreshToken)))
      } catch (error) {
        if (error instanceof RefreshRejectedError) {
          // One message for unknown, expired and revoked: telling the holder which it was tells an
          // attacker probing tokens whether the token was ever real.
          return c.json({ message: "That refresh token is not usable. Start a new run." }, 401)
        }
        throw error
      }
    },
  )

function present(minted: MintedProxyToken) {
  return {
    accessExpiresAt: minted.accessExpiresAt.toISOString(),
    accessToken: minted.accessToken,
    id: minted.id,
    refreshExpiresAt: minted.refreshExpiresAt.toISOString(),
    refreshToken: minted.refreshToken,
  }
}

app.route("", proxyTokens)

export default app
