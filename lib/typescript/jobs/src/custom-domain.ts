import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager"
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3"
import { crudCustomDomain, fetchCustomDomain, fetchDeployment, fetchProject } from "@lib/dao"
import { publishRoute as publishLambdaRoute, type Route, withdrawRoute } from "@lib/lambda"
import type { DB } from "@sproutos/db"
import * as acme from "acme-client"
import { resolve4, resolve6, resolveCname, resolveTxt } from "node:dns/promises"
import { Redis } from "ioredis"
import type { Kysely } from "kysely"
import { v7 } from "uuid"
import { enqueue } from "./queue"
import type { JobHandler } from "./worker"
import { certificateVersionKey } from "./certificate-version"
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
const RETRY_AFTER_MS = 60_000
const RENEWAL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000
const MAX_RETRY_MS = 24 * 60 * 60 * 1000

type Resolver = {
  resolve4(hostname: string): Promise<string[]>
  resolve6(hostname: string): Promise<string[]>
  resolveCname(hostname: string): Promise<string[]>
  resolveTxt(hostname: string): Promise<string[][]>
}

type Dependencies = {
  now: () => Date
  resolver: Resolver
  s3: S3Client
  secrets: SecretsManagerClient
  valkey: Redis
  publishRoute: typeof publishLambdaRoute
  issue: typeof issueCertificate
  refreshRenewal: typeof refreshRenewalSchedule
  scheduleIssued: typeof scheduleIssuedCertificate
}

export type CustomDomainDeletionDependencies = {
  bucket: string
  s3: Pick<S3Client, "send">
  valkey: Redis
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
    issue: issueCertificate,
    refreshRenewal: refreshRenewalSchedule,
    scheduleIssued: scheduleIssuedCertificate,
  }
}

function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === "") throw new Error(`${name} is required`)
  return value
}

function minimumCertificateAcks(): number {
  const value = Number(process.env.ROUTER_CERTIFICATE_MIN_ACKS ?? "1")
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("ROUTER_CERTIFICATE_MIN_ACKS must be a positive integer")
  }
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

async function loadedReplicaCount(
  valkey: Redis,
  hostname: string,
  objectVersion: string,
): Promise<number> {
  let cursor = "0"
  let count = 0
  const pattern = `cert:loaded:${hostname}:${certificateVersionKey(objectVersion)}:*`
  do {
    // eslint-disable-next-line no-await-in-loop -- Redis SCAN is cursor based.
    const [next, keys] = await valkey.scan(cursor, "MATCH", pattern, "COUNT", 100)
    cursor = next
    count += keys.length
  } while (cursor !== "0")
  return count
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
  },
  leaseToken: string,
  dependencies: CustomDomainDeletionDependencies,
): Promise<void> {
  await withdrawRoute(dependencies.valkey, domain.hostname)
  await dependencies.valkey.del(`custom-domain:pending:${domain.hostname}`)

  if (domain.certificateObjectKey !== null) {
    await deleteCertificateObjectVersions(
      dependencies.s3,
      dependencies.bucket,
      domain.certificateObjectKey,
      domain.certificateObjectVersion,
    )
  }
  await dependencies.valkey.publish(
    "certificates:invalidate",
    JSON.stringify({ hostname: domain.hostname, deleted: true }),
  )
  if (!(await crudCustomDomain(db).finishDelete(domain.id, leaseToken))) {
    throw new Error(`Custom domain ${domain.id} lost its deletion lease`)
  }
}

/** Remove the private key from every retained S3 version, not just the version routers loaded. */
export async function deleteCertificateObjectVersions(
  s3: Pick<S3Client, "send">,
  bucket: string,
  key: string,
  currentVersion: string | null,
): Promise<void> {
  if (currentVersion === null) {
    // Local/non-versioned compatibility. Production issuance refuses a missing VersionId.
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
    return
  }

  for (;;) {
    const listed = await s3.send(
      new ListObjectVersionsCommand({ Bucket: bucket, Prefix: key, MaxKeys: 1000 }),
    )
    const versions = [...(listed.Versions ?? []), ...(listed.DeleteMarkers ?? [])].flatMap(
      ({ Key, VersionId }) => (Key === key && VersionId !== undefined ? [{ Key, VersionId }] : []),
    )
    if (versions.length === 0) {
      if (listed.IsTruncated === true) {
        throw new Error(`S3 truncated certificate versions for ${key} without deletable entries`)
      }
      return
    }

    const deleted = await s3.send(
      new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: versions, Quiet: true } }),
    )
    if ((deleted.Errors?.length ?? 0) > 0) {
      const failures = deleted
        .Errors!.map(
          ({ VersionId, Code }) => `${VersionId ?? "unknown version"}: ${Code ?? "unknown error"}`,
        )
        .join(", ")
      throw new Error(`S3 failed to delete certificate versions for ${key}: ${failures}`)
    }
  }
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

export function scanCustomDomains(): JobHandler {
  return async (_job, { db }) => {
    const due = await fetchCustomDomain(db).listDueQuery(new Date()).execute()
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
    let failureStatus: "failed" | "renewal_warning" | "propagating" =
      domain.certificateExpiresAt !== null ? "renewal_warning" : "failed"

    try {
      if (domain.status === "deleting") {
        await deleteCustomDomainResources(db, domain, leaseToken, {
          bucket: required("TENANT_CERTIFICATE_BUCKET"),
          s3: deps.s3,
          valkey: deps.valkey,
        })
        return
      }

      if (domain.verifiedAt === null && domain.claimExpiresAt <= deps.now()) {
        await deps.valkey.del(`custom-domain:pending:${domain.hostname}`)
        await crudCustomDomain(db).update(domain.organizationId, domain.id, {
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
        const minimum = minimumCertificateAcks()
        const loaded = await loadedReplicaCount(
          deps.valkey,
          domain.hostname,
          domain.certificateObjectVersion,
        )
        if (loaded >= minimum) {
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
            arn: `arn:aws:lambda:${process.env.AWS_REGION ?? "us-east-1"}:${required("AWS_ACCOUNT_ID")}:function:sproutos-app-${domain.projectId}:live`,
            projectId: domain.projectId,
            organizationId: domain.organizationId,
            deploymentId: deployment.id,
          }
          await activateCustomDomain({
            publishRoute: () => deps.publishRoute(deps.valkey, domain.hostname, route),
            clearPending: async () => {
              await deps.valkey.del(`custom-domain:pending:${domain.hostname}`)
            },
            cleanupObsolete: async () => {
              if (
                domain.deployedCertificateObjectKey !== null &&
                domain.deployedCertificateObjectVersion !== null &&
                (domain.deployedCertificateObjectKey !== domain.certificateObjectKey ||
                  domain.deployedCertificateObjectVersion !== domain.certificateObjectVersion)
              ) {
                await deps.s3.send(
                  new DeleteObjectCommand({
                    Bucket: required("TENANT_CERTIFICATE_BUCKET"),
                    Key: domain.deployedCertificateObjectKey,
                    VersionId: domain.deployedCertificateObjectVersion,
                  }),
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
              await crudCustomDomain(db).update(domain.organizationId, domain.id, {
                status: "active",
                statusReason: null,
                deployedCertificateObjectKey: domain.certificateObjectKey,
                deployedCertificateObjectVersion: domain.certificateObjectVersion,
                nextRetryAt,
                consecutiveFailures: 0,
              })
            },
          })
        } else {
          await crudCustomDomain(db).update(domain.organizationId, domain.id, {
            statusReason: `Certificate stored; waiting for the Rust edge (${loaded}/${minimum} replicas loaded).`,
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
          await crudCustomDomain(db).update(domain.organizationId, domain.id, {
            nextRenewalAt: schedule.nextRenewalAt,
            renewalInfoRetryAt: schedule.renewalInfoRetryAt,
            renewalInfoExplanationUrl: schedule.renewalInfoExplanationUrl,
            nextRetryAt: nextCertificateWorkAt(schedule),
          })
          if (schedule.nextRenewalAt > deps.now()) return
        } else {
          return
        }
      }
      if (!renewing) {
        const [ownsHostname, pointsToIngress] = await Promise.all([
          hasOwnershipTxt(deps.resolver, domain.hostname, domain.verificationToken),
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
          await crudCustomDomain(db).update(domain.organizationId, domain.id, {
            status: "pending_dns",
            statusReason: `Waiting for the ${missing} to resolve publicly.`,
            lastCheckedAt: deps.now(),
            nextRetryAt: new Date(deps.now().getTime() + RETRY_AFTER_MS),
            consecutiveFailures: 0,
          })
          return
        }
      }

      await crudCustomDomain(db).update(domain.organizationId, domain.id, {
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

      await crudCustomDomain(db).update(domain.organizationId, domain.id, {
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
        statusReason: "Certificate issued; waiting for every active Rust edge replica to load it.",
        consecutiveFailures: 0,
      })
      await deps.valkey.publish(
        "certificates:invalidate",
        JSON.stringify({
          hostname: domain.hostname,
          objectKey,
          objectVersion: stored.VersionId,
        }),
      )
    } catch (error) {
      const failures = domain.consecutiveFailures + 1
      await crudCustomDomain(db).update(domain.organizationId, domain.id, {
        status: failureStatus,
        statusReason:
          error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
        consecutiveFailures: failures,
        nextRetryAt: customDomainRetryAfter(deps.now(), failures),
      })
      throw error
    } finally {
      await crudCustomDomain(db).releaseReconciliation(domain.id, leaseToken)
    }
  }
}
