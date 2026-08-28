import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager"
import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3"
import { crudCustomDomain, fetchCustomDomain, fetchDeployment, fetchProject } from "@lib/dao"
import { publishRoute as publishLambdaRoute, type Route } from "@lib/lambda"
import * as acme from "acme-client"
import { resolve4, resolve6, resolveCname, resolveTxt } from "node:dns/promises"
import { Redis } from "ioredis"
import { v7 } from "uuid"
import { enqueue } from "./queue"
import type { JobHandler } from "./worker"
import { certificateVersionKey } from "./certificate-version"

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
    directoryUrl: process.env.ACME_DIRECTORY_URL ?? acme.directory.letsencrypt.staging,
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
  /*
   * TODO(custom-domains): prefer ACME Renewal Information once acme-client exposes RFC 9773.
   * Until then this conservative fallback starts renewal 30 days before expiry; it must not be
   * mistaken for a permanent assumption that certificates always have a 90-day lifetime.
   */
  return new Date(expiresAt.getTime() - RENEWAL_WINDOW_MS)
}

export function customDomainRetryAfter(now: Date, consecutiveFailures: number): Date {
  const exponent = Math.min(Math.max(consecutiveFailures, 0), 10)
  return new Date(now.getTime() + Math.min(MAX_RETRY_MS, RETRY_AFTER_MS * 2 ** exponent))
}

export async function activateCustomDomain(callbacks: {
  publishRoute: () => Promise<void>
  clearPending: () => Promise<void>
  markActive: () => Promise<void>
}): Promise<void> {
  // The database must never claim a hostname is active before the request hot path can resolve it.
  await callbacks.publishRoute()
  await callbacks.clearPending()
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
        if (domain.certificateObjectKey !== null) {
          await deps.s3.send(
            new DeleteObjectCommand({
              Bucket: required("TENANT_CERTIFICATE_BUCKET"),
              Key: domain.certificateObjectKey,
              VersionId: domain.certificateObjectVersion ?? undefined,
            }),
          )
        }
        await deps.valkey.publish(
          "certificates:invalidate",
          JSON.stringify({ hostname: domain.hostname, deleted: true }),
        )
        await crudCustomDomain(db).finishDelete(domain.id, leaseToken)
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

      if (domain.status === "propagating" && domain.certificateObjectVersion !== null) {
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
            markActive: async () => {
              await crudCustomDomain(db).update(domain.organizationId, domain.id, {
                status: "active",
                statusReason: null,
                nextRetryAt: null,
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
          ? "Renewing the certificate."
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
        certificate = await issueCertificate(deps, domain.hostname)
      } finally {
        clearInterval(heartbeat)
      }
      if (heartbeatFailed) {
        throw new Error("Lost the reconciliation lease while the certificate was issuing")
      }
      const objectKey = `custom-domains/${domain.id}/${certificate.expiresAt.toISOString()}.json`
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
        certificateIssuedAt: certificate.issuedAt,
        certificateExpiresAt: certificate.expiresAt,
        nextRenewalAt: nextRenewal(certificate.expiresAt),
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
