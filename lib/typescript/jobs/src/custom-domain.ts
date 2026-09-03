import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager"
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3"
import {
  crudCustomDomain,
  fetchCustomDomain,
  fetchDeployment,
  fetchManagedCustomDomainPolicy,
  fetchProject,
} from "@lib/dao"
import type { DB } from "@sproutos/db"
import {
  lambdaAliasArn,
  publishRoute as publishLambdaRoute,
  type Route,
  withdrawRoute as withdrawLambdaRoute,
} from "@lib/lambda"
import * as acme from "acme-client"
import { createHash } from "node:crypto"
import { resolve4, resolve6, resolveCname, resolveTxt } from "node:dns/promises"
import { Redis } from "ioredis"
import type { Kysely, Updateable } from "kysely"
import { v7 } from "uuid"
import { enqueue } from "./queue"
import type { JobHandler } from "./worker"
import { certificateVersionKey } from "./certificate-version"
import { deleteCertificateObjectVersions } from "./certificate-objects"
import { certificateDeploymentQuorum } from "./certificate-quorum"
import {
  configuredAcmeDirectoryUrl,
  refreshRenewalSchedule,
  scheduleIssuedCertificate,
  type RenewalSchedule,
} from "./acme-renewal"

export const CUSTOM_DOMAIN_KINDS = {
  scan: "platform.custom_domain_scan",
  reconcile: "platform.custom_domain_reconcile",
} as const

const CHALLENGE_TTL_SECONDS = 15 * 60
const OWNERSHIP_PRESENT_TTL_SECONDS = 15 * 60
const OWNERSHIP_ABSENT_TTL_SECONDS = 60
const RETRY_AFTER_MS = 60_000
const RENEWAL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000
const MAX_RETRY_MS = 24 * 60 * 60 * 1000

class ReconciliationCancelledError extends Error {}

type Resolver = {
  resolve4(hostname: string): Promise<string[]>
  resolve6(hostname: string): Promise<string[]>
  resolveCname(hostname: string): Promise<string[]>
  resolveTxt(hostname: string): Promise<string[][]>
}

type OwnershipCache = {
  get(key: string): Promise<string | null>
  set(key: string, value: string, mode: "EX", ttlSeconds: number): Promise<unknown>
}

type OwnershipCacheInvalidator = {
  del(key: string): Promise<unknown>
}

type Dependencies = {
  now: () => Date
  resolver: Resolver
  s3: S3Client
  secrets: SecretsManagerClient
  valkey: Redis
  publishRoute: typeof publishLambdaRoute
  withdrawRoute: typeof withdrawLambdaRoute
  issue: typeof issueCertificate
  refreshRenewal: typeof refreshRenewalSchedule
  scheduleIssued: typeof scheduleIssuedCertificate
  afterCertificateStored: () => Promise<void>
}

export type CustomDomainDeletionDependencies = {
  bucket: string | (() => string)
  s3: Pick<S3Client, "send">
  valkey: Redis
  withdrawRoute?: typeof withdrawLambdaRoute
}

function awsConfig() {
  return {
    region: process.env.AWS_REGION ?? "us-east-1",
    ...(process.env.AWS_ENDPOINT_URL === undefined
      ? {}
      : { endpoint: process.env.AWS_ENDPOINT_URL }),
  }
}

let sharedValkey: Redis | undefined
function defaults(): Dependencies {
  sharedValkey ??= new Redis(process.env.VALKEY_URL ?? "redis://localhost:41023")
  const config = awsConfig()
  return {
    now: () => new Date(),
    resolver: { resolve4, resolve6, resolveCname, resolveTxt },
    s3: new S3Client({ ...config, forcePathStyle: process.env.AWS_ENDPOINT_URL !== undefined }),
    secrets: new SecretsManagerClient(config),
    valkey: sharedValkey,
    publishRoute: publishLambdaRoute,
    withdrawRoute: withdrawLambdaRoute,
    issue: issueCertificate,
    refreshRenewal: refreshRenewalSchedule,
    scheduleIssued: scheduleIssuedCertificate,
    afterCertificateStored: () => Promise.resolve(),
  }
}

function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === "") throw new Error(`${name} is required`)
  return value
}

function challengeKey(hostname: string, token: string): string {
  return `acme:http-01:${hostname}:${token}`
}

async function markPending(valkey: Redis, hostname: string): Promise<void> {
  await valkey.set(`custom-domain:pending:${hostname}`, "1", "EX", 30 * 24 * 60 * 60)
}

export async function hasOwnershipTxt(
  resolver: Resolver,
  hostname: string,
  expected: string,
): Promise<boolean> {
  try {
    const records = await resolver.resolveTxt(`_sproutos-challenge.${hostname}`)
    return records.some((chunks) => chunks.join("") === expected)
  } catch {
    return false
  }
}

function ownershipCacheKey(hostname: string, expected: string): string {
  const proof = createHash("sha256").update(expected).digest("hex")
  return `custom-domain:ownership:v1:${hostname}:${proof}`
}

export async function clearOwnershipTxtCache(
  valkey: OwnershipCacheInvalidator,
  hostname: string,
  expected: string,
): Promise<void> {
  await valkey.del(ownershipCacheKey(hostname, expected))
}

export async function hasOwnershipTxtCached(
  resolver: Resolver,
  valkey: OwnershipCache,
  hostname: string,
  expected: string,
): Promise<boolean> {
  const key = ownershipCacheKey(hostname, expected)
  const cached = await valkey.get(key)
  if (cached === "1") return true
  if (cached === "0") return false

  const present = await hasOwnershipTxt(resolver, hostname, expected)
  await valkey.set(
    key,
    present ? "1" : "0",
    "EX",
    present ? OWNERSHIP_PRESENT_TTL_SECONDS : OWNERSHIP_ABSENT_TTL_SECONDS,
  )
  return present
}

async function addresses(resolver: Resolver, hostname: string): Promise<Set<string>> {
  const [ipv4, ipv6] = await Promise.all([
    resolver.resolve4(hostname).catch(() => []),
    resolver.resolve6(hostname).catch(() => []),
  ])
  return new Set([...ipv4, ...ipv6].map((address) => address.toLowerCase()))
}

export async function trafficPointsToIngress(
  resolver: Resolver,
  hostname: string,
  ingressHostname: string,
): Promise<boolean> {
  try {
    const cnames = await resolver.resolveCname(hostname)
    if (cnames.some((value) => value.replace(/\.$/, "").toLowerCase() === ingressHostname)) {
      return true
    }
  } catch {
    // Apex records and providers which flatten CNAMEs are compared by resolved addresses below.
  }

  const [actual, expected] = await Promise.all([
    addresses(resolver, hostname),
    addresses(resolver, ingressHostname),
  ])
  return expected.size > 0 && [...actual].some((address) => expected.has(address))
}

async function managedPolicyOwnsDomain(
  db: Kysely<DB>,
  domain: { managedDomainPolicyId: string | null; hostname: string; organizationId: string },
): Promise<boolean> {
  if (domain.managedDomainPolicyId === null) return false
  const policy = await fetchManagedCustomDomainPolicy(db).getOne(domain.managedDomainPolicyId, [
    "organizationId",
    "status",
    "suffix",
  ])
  if (
    policy === undefined ||
    policy.status !== "active" ||
    policy.organizationId !== domain.organizationId
  ) {
    return false
  }
  const labels = domain.hostname.split(".")
  const suffixLabels = policy.suffix.split(".")
  return labels.length === suffixLabels.length + 1 && domain.hostname.endsWith(`.${policy.suffix}`)
}

async function accountKey(deps: Dependencies): Promise<string> {
  const secret = await deps.secrets.send(
    new GetSecretValueCommand({ SecretId: required("ACME_ACCOUNT_KEY_SECRET_ID") }),
  )
  const pem = secret.SecretString
  if (pem === undefined || pem === "") {
    throw new Error("The ACME account-key secret has no SecretString PEM value")
  }
  return pem
}

async function issueCertificate(
  deps: Dependencies,
  hostname: string,
): Promise<{ certificatePem: string; privateKeyPem: string; issuedAt: Date; expiresAt: Date }> {
  const [privateKey, csr] = await acme.crypto.createCsr({ commonName: hostname })
  const client = new acme.Client({
    accountKey: await accountKey(deps),
    directoryUrl: configuredAcmeDirectoryUrl(),
  })

  const certificatePem = await client.auto({
    csr,
    email: required("ACME_CONTACT_EMAIL"),
    termsOfServiceAgreed: true,
    challengePriority: ["http-01"],
    challengeCreateFn: async (_authorization, challenge, keyAuthorization) => {
      await deps.valkey.set(
        challengeKey(hostname, challenge.token),
        keyAuthorization,
        "EX",
        CHALLENGE_TTL_SECONDS,
      )
    },
    challengeRemoveFn: async (_authorization, challenge) => {
      await deps.valkey.del(challengeKey(hostname, challenge.token))
    },
  })
  const info = acme.crypto.readCertificateInfo(certificatePem)
  return {
    certificatePem,
    privateKeyPem: privateKey.toString("utf8"),
    issuedAt: info.notBefore,
    expiresAt: info.notAfter,
  }
}

export function nextRenewal(expiresAt: Date): Date {
  // Public compatibility name for the bounded fallback used when the CA does not offer RFC 9773.
  return new Date(expiresAt.getTime() - RENEWAL_WINDOW_MS)
}

function nextCertificateWorkAt(schedule: RenewalSchedule): Date {
  if (
    schedule.renewalInfoRetryAt !== null &&
    schedule.renewalInfoRetryAt < schedule.nextRenewalAt
  ) {
    return schedule.renewalInfoRetryAt
  }
  return schedule.nextRenewalAt
}

export function customDomainRetryAfter(now: Date, consecutiveFailures: number): Date {
  const exponent = Math.min(Math.max(consecutiveFailures, 0), 10)
  return new Date(now.getTime() + Math.min(MAX_RETRY_MS, RETRY_AFTER_MS * 2 ** exponent))
}

/**
 * Remove one ACME-backed hostname through the same state machine used by the domain API.
 *
 * The route disappears before the certificate. A retry therefore sees either an intact route and
 * certificate or a harmlessly repeated delete; it never leaves a hostname routing to a project
 * after its certificate has been removed. A busy reconciliation is an error, not success: account
 * deletion must not finish while an issuer still owns the domain lease.
 */
export async function tearDownCustomDomain(
  db: Kysely<DB>,
  input: { id: string; organizationId: string },
  dependencies: CustomDomainDeletionDependencies,
): Promise<boolean> {
  const deleting = await crudCustomDomain(db).beginDelete(input.organizationId, input.id)
  if (deleting === undefined) return false

  const leaseToken = v7()
  const domain = await crudCustomDomain(db).claimReconciliation(input.id, leaseToken)
  if (domain === undefined) {
    throw new Error(`Custom domain ${input.id} is being reconciled; retry teardown`)
  }

  try {
    await deleteCustomDomainResources(db, domain, leaseToken, dependencies)
    return true
  } finally {
    await crudCustomDomain(db).releaseReconciliation(input.id, leaseToken)
  }
}

async function deleteCustomDomainResources(
  db: Kysely<DB>,
  domain: {
    id: string
    hostname: string
    certificateObjectKey: string | null
    certificateObjectVersion: string | null
    deployedCertificateObjectKey: string | null
  },
  leaseToken: string,
  dependencies: CustomDomainDeletionDependencies,
): Promise<void> {
  await deleteCustomDomain({
    withdrawRoute: () =>
      (dependencies.withdrawRoute ?? withdrawLambdaRoute)(dependencies.valkey, domain.hostname),
    clearPending: async () => {
      await dependencies.valkey.del(`custom-domain:pending:${domain.hostname}`)
    },
    deleteObjects: async () => {
      const bucket =
        typeof dependencies.bucket === "string" ? dependencies.bucket : dependencies.bucket()
      const keys = new Set(
        [
          `custom-domains/${domain.id}/current.json`,
          domain.certificateObjectKey,
          domain.deployedCertificateObjectKey,
        ].filter((key): key is string => key !== null),
      )
      for (const key of keys) {
        // eslint-disable-next-line no-await-in-loop -- each exact certificate key is independent.
        await deleteCertificateObjectVersions(dependencies.s3, bucket, key)
      }
    },
    invalidateCertificates: async () => {
      await dependencies.valkey.publish(
        "certificates:invalidate",
        JSON.stringify({ hostname: domain.hostname, deleted: true }),
      )
    },
    finishDelete: async () => {
      if (!(await crudCustomDomain(db).finishDelete(domain.id, leaseToken))) {
        throw new Error(`Custom domain ${domain.id} lost its deletion lease`)
      }
    },
  })
}

export async function activateCustomDomain(callbacks: {
  publishRoute: () => Promise<void>
  clearPending: () => Promise<void>
  cleanupObsolete?: () => Promise<void>
  markActive: () => Promise<void>
}): Promise<void> {
  // The database must never claim a hostname is active before the request hot path can resolve it.
  await callbacks.publishRoute()
  await callbacks.clearPending()
  await callbacks.cleanupObsolete?.()
  await callbacks.markActive()
}

/**
 * Withdraw the request-path state before deleting private-key material or the durable claim.
 *
 * Every operation is idempotent. If the worker dies after either Valkey delete, the retry starts
 * by withdrawing both again and cannot accidentally make the hostname routable while finishing
 * S3 cleanup. The database row remains `deleting` until the final callback commits.
 */
export async function deleteCustomDomain(callbacks: {
  withdrawRoute: () => Promise<void>
  clearPending: () => Promise<void>
  deleteObjects: () => Promise<void>
  invalidateCertificates: () => Promise<void>
  finishDelete: () => Promise<void>
}): Promise<void> {
  await callbacks.withdrawRoute()
  await callbacks.clearPending()
  await callbacks.deleteObjects()
  await callbacks.invalidateCertificates()
  await callbacks.finishDelete()
}

export function scanCustomDomains(): JobHandler {
  return async (_job, { db }) => {
    const due = await fetchCustomDomain(db)
      .listDueQuery(new Date(), configuredAcmeDirectoryUrl())
      .execute()
    for (const domain of due) {
      // eslint-disable-next-line no-await-in-loop -- bounded scan; enqueue idempotency settles races.
      await enqueue(db, {
        kind: CUSTOM_DOMAIN_KINDS.reconcile,
        organizationId: domain.organizationId,
        payload: { domainId: domain.id },
        idempotencyKey: `${CUSTOM_DOMAIN_KINDS.reconcile}:${domain.id}:${new Date().toISOString().slice(0, 16)}`,
        maxAttempts: 5,
      })
    }
  }
}

export function reconcileCustomDomain(options?: Partial<Dependencies>): JobHandler {
  return async (job, { db, keepAlive }) => {
    const payload = job.payload as { domainId?: unknown }
    if (typeof payload.domainId !== "string") {
      throw new Error("Custom-domain reconciliation requires domainId")
    }
    const deps = { ...defaults(), ...options }
    const leaseToken = v7()
    const domain = await crudCustomDomain(db).claimReconciliation(payload.domainId, leaseToken)
    if (domain === undefined) return
    const updateOwned = async (data: Updateable<DB["customDomain"]>) => {
      const updated = await crudCustomDomain(db).updateReconciliation(domain.id, leaseToken, data)
      if (updated === undefined) throw new ReconciliationCancelledError()
      return updated
    }
    let failureStatus: "failed" | "renewal_warning" | "propagating" =
      domain.certificateExpiresAt !== null ? "renewal_warning" : "failed"

    try {
      if (domain.status === "deleting") {
        await deleteCustomDomainResources(db, domain, leaseToken, {
          bucket: () => required("TENANT_CERTIFICATE_BUCKET"),
          s3: deps.s3,
          valkey: deps.valkey,
          withdrawRoute: deps.withdrawRoute,
        })
        return
      }

      const managedOwnership = await managedPolicyOwnsDomain(db, domain)
      if (domain.managedDomainPolicyId !== null && !managedOwnership) {
        await updateOwned({
          status: "deleting",
          statusReason: "The managed-domain policy is no longer active for this organization.",
          nextRetryAt: deps.now(),
          consecutiveFailures: 0,
        })
        return
      }

      if (domain.verifiedAt === null && domain.claimExpiresAt <= deps.now()) {
        await deps.valkey.del(`custom-domain:pending:${domain.hostname}`)
        await updateOwned({
          status: "deleting",
          statusReason: "The unverified hostname claim expired after 30 days.",
          nextRetryAt: deps.now(),
          consecutiveFailures: 0,
        })
        return
      }

      const directoryUrl = configuredAcmeDirectoryUrl()
      const provenanceMatches =
        domain.certificateDirectoryUrl === directoryUrl &&
        domain.certificateIssuer !== null &&
        domain.renewalInfoCertificateId !== null

      if (
        domain.status === "propagating" &&
        domain.certificateObjectVersion !== null &&
        provenanceMatches
      ) {
        failureStatus = "propagating"
        const quorum = await certificateDeploymentQuorum(
          deps.valkey,
          `cert:loaded:${domain.hostname}:${certificateVersionKey(domain.certificateObjectVersion)}:`,
        )
        if (quorum.ready) {
          const project = await fetchProject(db).getInOrganization(
            domain.organizationId,
            domain.projectId,
            ["liveDeploymentId"],
          )
          if (project?.liveDeploymentId === null || project?.liveDeploymentId === undefined) {
            throw new Error("The custom domain's project has no live deployment")
          }
          const deployment = await fetchDeployment(db).getForProject(
            domain.projectId,
            project.liveDeploymentId,
            ["id", "lambdaVersion", "preset", "status"],
          )
          if (
            deployment === undefined ||
            deployment.status !== "ready" ||
            deployment.preset === "static" ||
            deployment.lambdaVersion === null
          ) {
            throw new Error("The custom domain's live deployment is not a routable Lambda release")
          }
          const route: Route = {
            arn: lambdaAliasArn({
              region: process.env.AWS_REGION ?? "us-east-1",
              accountId: required("AWS_ACCOUNT_ID"),
              projectId: domain.projectId,
            }),
            projectId: domain.projectId,
            organizationId: domain.organizationId,
            deploymentId: deployment.id,
          }
          await db.transaction().execute(async (trx) => {
            const current = await trx
              .selectFrom("customDomain")
              .select("id")
              .where("id", "=", domain.id)
              .where("status", "=", "propagating")
              .where("reconcileLeaseToken", "=", leaseToken)
              .where("deletedAt", "is", null)
              .forUpdate()
              .executeTakeFirst()
            if (current === undefined) return
            // The row lock serializes this short external cutover with beginDelete. A deletion
            // requested first prevents publication; one requested after publication waits, then
            // durably enters deleting and withdraws the route on its reconciliation pass.
            await activateCustomDomain({
              publishRoute: () => deps.publishRoute(deps.valkey, domain.hostname, route),
              clearPending: async () => {
                await deps.valkey.del(`custom-domain:pending:${domain.hostname}`)
              },
              cleanupObsolete: async () => {
                const keys = new Set(
                  [domain.certificateObjectKey, domain.deployedCertificateObjectKey].filter(
                    (key): key is string => key !== null,
                  ),
                )
                for (const key of keys) {
                  // eslint-disable-next-line no-await-in-loop -- exact certificate keys are independent.
                  await deleteCertificateObjectVersions(
                    deps.s3,
                    required("TENANT_CERTIFICATE_BUCKET"),
                    key,
                    key === domain.certificateObjectKey && domain.certificateObjectVersion !== null
                      ? new Set([domain.certificateObjectVersion])
                      : new Set(),
                  )
                }
              },
              markActive: async () => {
                const nextRetryAt =
                  domain.nextRenewalAt === null
                    ? null
                    : nextCertificateWorkAt({
                        nextRenewalAt: domain.nextRenewalAt,
                        renewalInfoRetryAt: domain.renewalInfoRetryAt,
                        renewalInfoExplanationUrl: domain.renewalInfoExplanationUrl,
                        source: domain.renewalInfoRetryAt === null ? "unsupported" : "ari",
                      })
                const updated = await crudCustomDomain(trx).updateReconciliation(
                  domain.id,
                  leaseToken,
                  {
                    status: "active",
                    statusReason: null,
                    deployedCertificateObjectKey: domain.certificateObjectKey,
                    deployedCertificateObjectVersion: domain.certificateObjectVersion,
                    nextRetryAt,
                    consecutiveFailures: 0,
                  },
                )
                if (updated === undefined) throw new ReconciliationCancelledError()
              },
            })
          })
        } else {
          await updateOwned({
            statusReason: `Certificate stored; waiting for every serving Rust edge replica (${quorum.loaded}/${quorum.serving} loaded).`,
            nextRetryAt: new Date(deps.now().getTime() + RETRY_AFTER_MS),
            consecutiveFailures: 0,
          })
        }
        return
      }

      const renewing = domain.status === "active" || domain.status === "renewal_warning"
      if (
        renewing &&
        provenanceMatches &&
        domain.nextRenewalAt !== null &&
        domain.nextRenewalAt > deps.now()
      ) {
        const manualDnsCheckRequested =
          domain.nextRetryAt !== null && domain.nextRetryAt <= deps.now()
        let renewalDueNow = false
        let futureSchedule: RenewalSchedule = {
          nextRenewalAt: domain.nextRenewalAt,
          renewalInfoRetryAt: domain.renewalInfoRetryAt,
          renewalInfoExplanationUrl: domain.renewalInfoExplanationUrl,
          source: domain.renewalInfoRetryAt === null ? "unsupported" : "ari",
        }
        if (
          domain.renewalInfoRetryAt !== null &&
          domain.renewalInfoRetryAt <= deps.now() &&
          domain.renewalInfoCertificateId !== null &&
          domain.certificateExpiresAt !== null
        ) {
          const schedule = await deps.refreshRenewal({
            certificateId: domain.renewalInfoCertificateId,
            directoryUrl,
            expiresAt: domain.certificateExpiresAt,
            now: deps.now(),
          })
          await updateOwned({
            nextRenewalAt: schedule.nextRenewalAt,
            renewalInfoRetryAt: schedule.renewalInfoRetryAt,
            renewalInfoExplanationUrl: schedule.renewalInfoExplanationUrl,
            nextRetryAt: nextCertificateWorkAt(schedule),
          })
          renewalDueNow = schedule.nextRenewalAt <= deps.now()
          futureSchedule = schedule
        }

        // The API clears the ownership cache and moves nextRetryAt to now for a manual re-check.
        // Do not let the normal future-renewal fast path turn that control into a no-op: verify
        // both records again while continuing to serve the already-issued certificate.
        if (!renewalDueNow && manualDnsCheckRequested) {
          const [ownsHostname, pointsToIngress] = await Promise.all([
            managedOwnership
              ? Promise.resolve(true)
              : hasOwnershipTxtCached(
                  deps.resolver,
                  deps.valkey,
                  domain.hostname,
                  domain.verificationToken,
                ),
            trafficPointsToIngress(
              deps.resolver,
              domain.hostname,
              required("TENANT_INGRESS_HOST").toLowerCase(),
            ),
          ])
          const missing = [
            ...(ownsHostname ? [] : ["ownership TXT"]),
            ...(pointsToIngress ? [] : ["traffic record"]),
          ].join(" and ")
          await updateOwned({
            status: missing === "" ? "active" : "renewal_warning",
            statusReason:
              missing === ""
                ? null
                : `Certificate remains active, but waiting for the ${missing} to resolve publicly before renewal.`,
            lastCheckedAt: deps.now(),
            nextRetryAt:
              missing === ""
                ? nextCertificateWorkAt(futureSchedule)
                : new Date(deps.now().getTime() + RETRY_AFTER_MS),
            consecutiveFailures: 0,
          })
        }
        if (!renewalDueNow) return
      }
      if (!renewing) {
        const [ownsHostname, pointsToIngress] = await Promise.all([
          managedOwnership
            ? Promise.resolve(true)
            : hasOwnershipTxtCached(
                deps.resolver,
                deps.valkey,
                domain.hostname,
                domain.verificationToken,
              ),
          trafficPointsToIngress(
            deps.resolver,
            domain.hostname,
            required("TENANT_INGRESS_HOST").toLowerCase(),
          ),
        ])
        if (!ownsHostname || !pointsToIngress) {
          const missing = [
            ...(ownsHostname ? [] : ["ownership TXT"]),
            ...(pointsToIngress ? [] : ["traffic record"]),
          ].join(" and ")
          await markPending(deps.valkey, domain.hostname)
          await updateOwned({
            status: "pending_dns",
            statusReason: `Waiting for the ${missing} to resolve publicly.`,
            lastCheckedAt: deps.now(),
            nextRetryAt: new Date(deps.now().getTime() + RETRY_AFTER_MS),
            consecutiveFailures: 0,
          })
          return
        }
      }

      await updateOwned({
        status: "issuing",
        statusReason: renewing
          ? provenanceMatches
            ? "Renewing the certificate."
            : "Replacing a certificate whose ACME issuer provenance does not match the configured directory."
          : "DNS verified; issuing the certificate.",
        verifiedAt: domain.verifiedAt ?? deps.now(),
        lastCheckedAt: deps.now(),
        nextRetryAt: new Date(deps.now().getTime() + RETRY_AFTER_MS),
      })
      await markPending(deps.valkey, domain.hostname)

      let heartbeatFailed = false
      const heartbeat = setInterval(() => {
        void Promise.all([
          keepAlive(),
          crudCustomDomain(db).heartbeatReconciliation(domain.id, leaseToken),
        ]).then((alive) => {
          if (alive.some((value) => !value)) heartbeatFailed = true
        })
      }, 60_000)
      let certificate: Awaited<ReturnType<typeof issueCertificate>>
      try {
        certificate = await deps.issue(deps, domain.hostname)
      } finally {
        clearInterval(heartbeat)
      }
      if (heartbeatFailed) {
        throw new Error("Lost the reconciliation lease while the certificate was issuing")
      }
      const renewal = await deps.scheduleIssued({
        certificatePem: certificate.certificatePem,
        directoryUrl,
        expiresAt: certificate.expiresAt,
        now: deps.now(),
      })
      const objectKey = `custom-domains/${domain.id}/current.json`
      const storedVersion = await db.transaction().execute(async (trx) => {
        const locked = await trx
          .selectFrom("customDomain")
          .select(["deletedAt", "reconcileLeaseToken", "status"])
          .where("id", "=", domain.id)
          .forUpdate()
          .executeTakeFirst()
        if (
          locked === undefined ||
          locked.deletedAt !== null ||
          locked.status === "deleting" ||
          locked.reconcileLeaseToken !== leaseToken
        ) {
          throw new ReconciliationCancelledError()
        }

        // This is deliberately inside the short row-lock transaction. Deletion waits until the
        // exact immutable VersionId is recorded; if the process dies after S3 accepts the object,
        // the transaction releases the row and the waiting deleter lists that deterministic key.
        const stored = await deps.s3.send(
          new PutObjectCommand({
            Bucket: required("TENANT_CERTIFICATE_BUCKET"),
            Key: objectKey,
            Body: JSON.stringify({
              version: 1,
              hostname: domain.hostname,
              certificatePem: certificate.certificatePem,
              privateKeyPem: certificate.privateKeyPem,
              issuedAt: certificate.issuedAt.toISOString(),
              expiresAt: certificate.expiresAt.toISOString(),
              issuer: renewal.issuer,
              directoryUrl,
            }),
            ContentType: "application/json",
            ServerSideEncryption: "aws:kms",
            SSEKMSKeyId: required("TENANT_CERTIFICATE_KMS_KEY_ARN"),
          }),
        )
        if (stored.VersionId === undefined) {
          throw new Error("Certificate bucket versioning is not enabled; S3 returned no VersionId")
        }
        await deps.afterCertificateStored()

        const updated = await crudCustomDomain(trx).updateReconciliation(domain.id, leaseToken, {
          certificateObjectKey: objectKey,
          certificateObjectVersion: stored.VersionId,
          certificateIssuer: renewal.issuer,
          certificateDirectoryUrl: directoryUrl,
          certificateIssuedAt: certificate.issuedAt,
          certificateExpiresAt: certificate.expiresAt,
          renewalInfoCertificateId: renewal.certificateId,
          renewalInfoRetryAt: renewal.renewalInfoRetryAt,
          renewalInfoExplanationUrl: renewal.renewalInfoExplanationUrl,
          nextRenewalAt: renewal.nextRenewalAt,
          nextRetryAt: new Date(deps.now().getTime() + RETRY_AFTER_MS),
          status: "propagating",
          statusReason:
            "Certificate issued; waiting for every active Rust edge replica to load it.",
          consecutiveFailures: 0,
        })
        if (updated === undefined) {
          throw new ReconciliationCancelledError()
        }
        return stored.VersionId
      })
      await deleteCertificateObjectVersions(
        deps.s3,
        required("TENANT_CERTIFICATE_BUCKET"),
        objectKey,
        new Set(
          [
            storedVersion,
            domain.deployedCertificateObjectKey === objectKey
              ? domain.deployedCertificateObjectVersion
              : null,
          ].filter((version): version is string => version !== null),
        ),
      )
      await deps.valkey.publish(
        "certificates:invalidate",
        JSON.stringify({
          hostname: domain.hostname,
          objectKey,
          objectVersion: storedVersion,
        }),
      )
    } catch (error) {
      if (error instanceof ReconciliationCancelledError) return
      const failures = domain.consecutiveFailures + 1
      const updated = await crudCustomDomain(db).updateReconciliation(
        domain.id,
        leaseToken,
        {
          status: domain.status === "deleting" ? "deleting" : failureStatus,
          statusReason:
            error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
          consecutiveFailures: failures,
          nextRetryAt: customDomainRetryAfter(deps.now(), failures),
        },
        domain.status === "deleting",
      )
      if (updated === undefined) return
      throw error
    } finally {
      await crudCustomDomain(db).releaseReconciliation(domain.id, leaseToken)
    }
  }
}
