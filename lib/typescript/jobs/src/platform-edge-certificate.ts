import {
  ChangeResourceRecordSetsCommand,
  GetChangeCommand,
  ListResourceRecordSetsCommand,
  Route53Client,
  type ResourceRecordSet,
} from "@aws-sdk/client-route-53"
import { AutoScalingClient, StartInstanceRefreshCommand } from "@aws-sdk/client-auto-scaling"
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager"
import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3"
import { crudPlatformEdgeCertificate } from "@lib/dao"
import * as acme from "acme-client"
import { Resolver, resolve4, resolveNs, resolveTxt } from "node:dns/promises"
import { setTimeout as delay } from "node:timers/promises"
import { Redis } from "ioredis"
import { v7 } from "uuid"
import type { JobHandler } from "./worker"
import { certificateVersionKey } from "./certificate-version"
import { certificateDeploymentQuorum } from "./certificate-quorum"
import {
  configuredAcmeDirectoryUrl,
  refreshRenewalSchedule,
  scheduleIssuedCertificate,
  type RenewalSchedule,
} from "./acme-renewal"

export const PLATFORM_EDGE_CERTIFICATE_KIND = "platform.edge_certificate_reconcile"
export const PLATFORM_CERTIFICATE_OBJECT_KEY = "platform-edge/current.json"

const RENEWAL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000
const MAX_RETRY_MS = 24 * 60 * 60 * 1000
const ROUTE53_CHANGE_POLL_MS = 2_000
const ROUTE53_CHANGE_MAX_POLLS = 60
const DNS_PROPAGATION_POLL_MS = 2_000
const DNS_PROPAGATION_MAX_POLLS = 60

type DnsLookup = {
  resolveNameservers: (hostname: string) => Promise<string[]>
  resolvePublicTxt: (hostname: string) => Promise<string[][]>
  resolveAuthoritativeTxt: (hostname: string, nameserver: string) => Promise<string[][]>
}

const SYSTEM_DNS_LOOKUP: DnsLookup = {
  resolveNameservers: async (hostname) => {
    const labels = hostname.replace(/\.$/, "").split(".")
    for (let index = 0; index < labels.length - 1; index++) {
      try {
        // eslint-disable-next-line no-await-in-loop -- walk toward the zone cut until NS records exist.
        const nameservers = await resolveNs(labels.slice(index).join("."))
        if (nameservers.length > 0) return nameservers
      } catch {
        // An ordinary name below the zone has no NS RRset; its parent may be the zone apex.
      }
    }
    throw new Error(`could not discover authoritative nameservers for ${hostname}`)
  },
  resolvePublicTxt: resolveTxt,
  resolveAuthoritativeTxt: async (hostname, nameserver) => {
    const addresses = await resolve4(nameserver)
    if (addresses.length === 0) {
      throw new Error(`authoritative nameserver ${nameserver} has no IPv4 address`)
    }
    const resolver = new Resolver()
    resolver.setServers(addresses)
    return resolver.resolveTxt(hostname)
  },
}

type Certificate = {
  certificatePem: string
  privateKeyPem: string
  issuedAt: Date
  expiresAt: Date
}

export type PlatformCertificateConfig = {
  tenantDomain: string
  wildcardHostname: string
  egressHostname: string
  tenantZoneId: string
  egressZoneId: string
  bucket: string
  kmsKeyArn: string
  objectKey: string
  routerAsgNames: string[]
  rolloutEnabled: boolean
}

export type PlatformCertificateDependencies = {
  now: () => Date
  route53: Route53Client
  autoScaling: AutoScalingClient
  s3: S3Client
  secrets: SecretsManagerClient
  valkey: Redis
  sleep: (milliseconds: number) => Promise<void>
  dns: DnsLookup
  issue: (
    deps: PlatformCertificateDependencies,
    config: PlatformCertificateConfig,
  ) => Promise<Certificate>
  refreshRenewal: typeof refreshRenewalSchedule
  scheduleIssued: typeof scheduleIssuedCertificate
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
function dependencies(
  options: Partial<PlatformCertificateDependencies> = {},
): PlatformCertificateDependencies {
  const config = awsConfig()
  if (options.valkey === undefined) {
    sharedValkey ??= new Redis(process.env.VALKEY_URL ?? "redis://localhost:41023")
  }
  return {
    now: options.now ?? (() => new Date()),
    route53: options.route53 ?? new Route53Client(config),
    autoScaling: options.autoScaling ?? new AutoScalingClient(config),
    s3:
      options.s3 ??
      new S3Client({ ...config, forcePathStyle: process.env.AWS_ENDPOINT_URL !== undefined }),
    secrets: options.secrets ?? new SecretsManagerClient(config),
    valkey: options.valkey ?? sharedValkey!,
    sleep:
      options.sleep ??
      (async (milliseconds) => {
        await delay(milliseconds)
      }),
    dns: options.dns ?? SYSTEM_DNS_LOOKUP,
    issue: options.issue ?? issuePlatformCertificate,
    refreshRenewal: options.refreshRenewal ?? refreshRenewalSchedule,
    scheduleIssued: options.scheduleIssued ?? scheduleIssuedCertificate,
  }
}

function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.trim() === "") throw new Error(`${name} is required`)
  return value.trim()
}

function normalizeHostname(value: string, name: string): string {
  const hostname = value.trim().replace(/\.$/, "").toLowerCase()
  if (
    hostname === "" ||
    hostname.length > 253 ||
    hostname.includes("*") ||
    hostname.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) {
    throw new Error(`${name} is not a valid exact DNS hostname`)
  }
  return hostname
}

export function platformCertificateConfig(): PlatformCertificateConfig {
  const tenantDomain = normalizeHostname(required("TENANT_DOMAIN"), "TENANT_DOMAIN")
  const egressHostname = normalizeHostname(
    required("PLATFORM_EDGE_EGRESS_HOSTNAME"),
    "PLATFORM_EDGE_EGRESS_HOSTNAME",
  )
  if (egressHostname === tenantDomain) {
    throw new Error("PLATFORM_EDGE_EGRESS_HOSTNAME must not equal TENANT_DOMAIN")
  }
  const routerAsgNames = required("PLATFORM_ROUTER_ASG_NAMES")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "")
  if (routerAsgNames.length === 0 || new Set(routerAsgNames).size !== routerAsgNames.length) {
    throw new Error("PLATFORM_ROUTER_ASG_NAMES must contain unique comma-separated ASG names")
  }
  const rollout = required("PLATFORM_EDGE_ROLLOUT_ENABLED")
  if (rollout !== "0" && rollout !== "1") {
    throw new Error("PLATFORM_EDGE_ROLLOUT_ENABLED must be 0 or 1")
  }
  return {
    tenantDomain,
    wildcardHostname: `*.${tenantDomain}`,
    egressHostname,
    tenantZoneId: required("PLATFORM_ACME_TENANT_ZONE_ID"),
    egressZoneId: required("PLATFORM_ACME_EGRESS_ZONE_ID"),
    bucket: required("TENANT_CERTIFICATE_BUCKET"),
    kmsKeyArn: required("TENANT_CERTIFICATE_KMS_KEY_ARN"),
    // One stable key plus an exact VersionId is the certificate handoff protocol. Allowing an
    // environment override can orphan the prior private-key version where cleanup cannot find it.
    objectKey: PLATFORM_CERTIFICATE_OBJECT_KEY,
    routerAsgNames,
    rolloutEnabled: rollout === "1",
  }
}

export function platformCertificateNames(config: PlatformCertificateConfig): string[] {
  return [config.tenantDomain, config.wildcardHostname, config.egressHostname]
}

function challengeRecordName(identifier: string): string {
  return `_acme-challenge.${identifier.replace(/^\*\./, "").replace(/\.$/, "").toLowerCase()}`
}

function quotedTxt(value: string): string {
  return JSON.stringify(value)
}

function txtValues(records: string[][]): string[] {
  // A TXT RDATA value may be split into multiple character strings. DNS clients present those as
  // one string array per record, so join within each record instead of flattening records together.
  return records.map((parts) => parts.join(""))
}

function route53TxtValue(value: string): string {
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === "string" ? parsed : value
  } catch {
    return value
  }
}

function exactRecord(records: ResourceRecordSet[] | undefined, name: string) {
  const normalized = `${name.replace(/\.$/, "")}.`.toLowerCase()
  return records?.find(
    (record) => record.Type === "TXT" && record.Name?.toLowerCase() === normalized,
  )
}

async function currentChallengeRecord(
  route53: Route53Client,
  zoneId: string,
  name: string,
): Promise<ResourceRecordSet | undefined> {
  const result = await route53.send(
    new ListResourceRecordSetsCommand({
      HostedZoneId: zoneId,
      StartRecordName: name,
      StartRecordType: "TXT",
      MaxItems: 1,
    }),
  )
  return exactRecord(result.ResourceRecordSets, name)
}

async function waitForRoute53(
  route53: Route53Client,
  changeId: string | undefined,
  sleep: PlatformCertificateDependencies["sleep"],
): Promise<void> {
  if (changeId === undefined) throw new Error("Route 53 returned no change ID")
  for (let poll = 0; poll < ROUTE53_CHANGE_MAX_POLLS; poll++) {
    // eslint-disable-next-line no-await-in-loop -- Route 53 exposes one monotonic change resource.
    const response = await route53.send(new GetChangeCommand({ Id: changeId }))
    if (response.ChangeInfo?.Status === "INSYNC") return
    // eslint-disable-next-line no-await-in-loop -- bounded asynchronous propagation poll.
    await sleep(ROUTE53_CHANGE_POLL_MS)
  }
  throw new Error(`Route 53 change ${changeId} did not become INSYNC within two minutes`)
}

async function waitForDnsPropagation(
  name: string,
  expected: string,
  sleep: PlatformCertificateDependencies["sleep"],
  dns: DnsLookup,
): Promise<void> {
  const nameservers = await dns.resolveNameservers(name)
  if (nameservers.length === 0) {
    throw new Error(`DNS returned no authoritative nameservers for ${name}`)
  }

  let missing = ["public resolver", ...nameservers]
  for (let poll = 0; poll < DNS_PROPAGATION_MAX_POLLS; poll++) {
    // Query the same public resolver path acme-client verifies through as well as every Route 53
    // authority. GetChange=INSYNC is a control-plane result; it does not prove a recursive resolver
    // has stopped serving the previous RRset from cache.
    // eslint-disable-next-line no-await-in-loop -- bounded propagation polling is intentionally sequential.
    const answers = await Promise.allSettled([
      dns.resolvePublicTxt(name),
      ...nameservers.map((nameserver) => dns.resolveAuthoritativeTxt(name, nameserver)),
    ])
    const labels = ["public resolver", ...nameservers]
    missing = labels.filter((_, index) => {
      const answer = answers[index]
      return answer?.status !== "fulfilled" || !txtValues(answer.value).includes(expected)
    })
    if (missing.length === 0) return
    // eslint-disable-next-line no-await-in-loop -- bounded asynchronous propagation poll.
    await sleep(DNS_PROPAGATION_POLL_MS)
  }
  throw new Error(
    `DNS TXT ${name} did not expose the ACME authorization through ${missing.join(", ")} within two minutes`,
  )
}

type PutDnsChallengeOptions = {
  sleep?: PlatformCertificateDependencies["sleep"]
  dns?: DnsLookup
  replaceExisting?: boolean
}

export async function putDnsChallenge(
  route53: Route53Client,
  zoneId: string,
  identifier: string,
  keyAuthorization: string,
  options: PutDnsChallengeOptions = {},
): Promise<void> {
  const sleep =
    options.sleep ??
    (async (milliseconds: number) => {
      await delay(milliseconds)
    })
  const dns = options.dns ?? SYSTEM_DNS_LOOKUP
  const name = challengeRecordName(identifier)
  // acme-client's DNS-01 callback value is already SHA-256(keyAuthorization), base64url encoded.
  // Hashing it again writes a different value from the one both acme-client and the CA validate.
  const value = quotedTxt(keyAuthorization)
  const current = options.replaceExisting
    ? undefined
    : await currentChallengeRecord(route53, zoneId, name)
  const values = new Set(
    (current?.ResourceRecords ?? [])
      .map((record) => record.Value)
      .filter((candidate): candidate is string => candidate !== undefined),
  )
  values.add(value)
  const changed = await route53.send(
    new ChangeResourceRecordSetsCommand({
      HostedZoneId: zoneId,
      ChangeBatch: {
        Comment: "SproutOS platform edge ACME DNS-01 challenge",
        Changes: [
          {
            Action: "UPSERT",
            ResourceRecordSet: {
              Name: name,
              Type: "TXT",
              TTL: 60,
              ResourceRecords: [...values]
                .toSorted((left, right) => left.localeCompare(right))
                .map((Value) => ({ Value })),
            },
          },
        ],
      },
    }),
  )
  await waitForRoute53(route53, changed.ChangeInfo?.Id, sleep)
  await waitForDnsPropagation(name, route53TxtValue(value), sleep, dns)
}

export async function removeDnsChallenge(
  route53: Route53Client,
  zoneId: string,
  identifier: string,
  keyAuthorization: string,
  sleep: PlatformCertificateDependencies["sleep"] = async (milliseconds) => {
    await delay(milliseconds)
  },
): Promise<void> {
  const name = challengeRecordName(identifier)
  const current = await currentChallengeRecord(route53, zoneId, name)
  if (current === undefined) return
  const value = quotedTxt(keyAuthorization)
  const remaining = (current.ResourceRecords ?? []).filter((record) => record.Value !== value)
  if (remaining.length === current.ResourceRecords?.length) return

  const resourceRecordSet =
    remaining.length === 0 ? current : { ...current, ResourceRecords: remaining }
  const changed = await route53.send(
    new ChangeResourceRecordSetsCommand({
      HostedZoneId: zoneId,
      ChangeBatch: {
        Comment: "SproutOS platform edge ACME DNS-01 cleanup",
        Changes: [
          {
            Action: remaining.length === 0 ? "DELETE" : "UPSERT",
            ResourceRecordSet: resourceRecordSet,
          },
        ],
      },
    }),
  )
  await waitForRoute53(route53, changed.ChangeInfo?.Id, sleep)
}

async function accountKey(secrets: SecretsManagerClient): Promise<string> {
  const result = await secrets.send(
    new GetSecretValueCommand({ SecretId: required("ACME_ACCOUNT_KEY_SECRET_ID") }),
  )
  if (result.SecretString === undefined || result.SecretString === "") {
    throw new Error("The ACME account-key secret has no SecretString PEM value")
  }
  return result.SecretString
}

function zoneForAuthorization(config: PlatformCertificateConfig, identifier: string): string {
  const exact = normalizeHostname(identifier.replace(/^\*\./, ""), "ACME authorization")
  if (exact === config.tenantDomain) return config.tenantZoneId
  if (exact === config.egressHostname) return config.egressZoneId
  throw new Error(`ACME requested an unexpected authorization for ${exact}`)
}

export async function issuePlatformCertificate(
  deps: PlatformCertificateDependencies,
  config: PlatformCertificateConfig,
): Promise<Certificate> {
  const [privateKey, csr] = await acme.crypto.createCsr({
    commonName: config.wildcardHostname,
    altNames: platformCertificateNames(config),
  })
  const client = new acme.Client({
    accountKey: await accountKey(deps.secrets),
    directoryUrl: configuredAcmeDirectoryUrl(),
  })
  // The apex and wildcard authorizations share `_acme-challenge.<tenant-domain>`. acme-client may
  // invoke callbacks concurrently, so serialize read/modify/write updates or each callback can
  // read the same old RRset and overwrite the other challenge digest.
  let dnsMutation = Promise.resolve()
  const initializedRecords = new Set<string>()
  const serializeDnsMutation = async (mutation: () => Promise<void>): Promise<void> => {
    const result = dnsMutation.then(mutation)
    dnsMutation = result.catch(() => undefined)
    await result
  }
  const certificatePem = await client.auto({
    csr,
    email: required("ACME_CONTACT_EMAIL"),
    termsOfServiceAgreed: true,
    challengePriority: ["dns-01"],
    challengeCreateFn: async (authorization, _challenge, keyAuthorization) => {
      const zoneId = zoneForAuthorization(config, authorization.identifier.value)
      const record = `${zoneId}:${challengeRecordName(authorization.identifier.value)}`
      const replaceExisting = !initializedRecords.has(record)
      initializedRecords.add(record)
      await serializeDnsMutation(() =>
        putDnsChallenge(deps.route53, zoneId, authorization.identifier.value, keyAuthorization, {
          sleep: deps.sleep,
          dns: deps.dns,
          replaceExisting,
        }),
      )
    },
    challengeRemoveFn: async (authorization, _challenge, keyAuthorization) => {
      await serializeDnsMutation(() =>
        removeDnsChallenge(
          deps.route53,
          zoneForAuthorization(config, authorization.identifier.value),
          authorization.identifier.value,
          keyAuthorization,
          deps.sleep,
        ),
      )
    },
  })
  const info = acme.crypto.readCertificateInfo(certificatePem)
  const covered = new Set(
    [info.domains.commonName, ...info.domains.altNames].map((x) => x.toLowerCase()),
  )
  for (const hostname of platformCertificateNames(config)) {
    if (!covered.has(hostname)) throw new Error(`Issued certificate does not cover ${hostname}`)
  }
  return {
    certificatePem,
    privateKeyPem: privateKey.toString("utf8"),
    issuedAt: info.notBefore,
    expiresAt: info.notAfter,
  }
}

export function nextPlatformRenewal(expiresAt: Date): Date {
  // Public compatibility name for the bounded fallback used when RFC 9773 is unavailable.
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

export function retryAfter(now: Date, consecutiveFailures: number): Date {
  const exponent = Math.min(Math.max(consecutiveFailures, 0), 10)
  const milliseconds = Math.min(MAX_RETRY_MS, 60_000 * 2 ** exponent)
  return new Date(now.getTime() + milliseconds)
}

export function platformCertificateObject(
  config: PlatformCertificateConfig,
  certificate: Certificate,
): string {
  return JSON.stringify({
    version: 1,
    hostname: config.wildcardHostname,
    hostnames: platformCertificateNames(config),
    certificatePem: certificate.certificatePem,
    privateKeyPem: certificate.privateKeyPem,
    issuedAt: certificate.issuedAt.toISOString(),
    expiresAt: certificate.expiresAt.toISOString(),
  })
}

export function platformVersionKey(objectVersion: string): string {
  return certificateVersionKey(objectVersion)
}

export async function requestPlatformRestart(
  autoScaling: AutoScalingClient,
  config: PlatformCertificateConfig,
): Promise<void> {
  if (!config.rolloutEnabled) {
    throw new Error("Platform edge rollout is disabled; refusing to refresh router instances")
  }
  for (const autoScalingGroupName of config.routerAsgNames) {
    try {
      // eslint-disable-next-line no-await-in-loop -- each accepted refresh is an independently auditable handoff.
      const refresh = await autoScaling.send(
        new StartInstanceRefreshCommand({
          AutoScalingGroupName: autoScalingGroupName,
          Strategy: "Rolling",
          Preferences: {
            // The certificate is S3 startup data, not a launch-template version. Auto rollback
            // would therefore boot the same certificate again and falsely imply it restored the
            // old version. Keeping 100% healthy with 200% headroom retains old instances until a
            // replacement actually passes every target-group health check.
            InstanceWarmup: 180,
            MinHealthyPercentage: 100,
            MaxHealthyPercentage: 200,
            SkipMatching: false,
          },
        }),
      )
      if (refresh.InstanceRefreshId === undefined) {
        throw new Error(`Auto Scaling accepted no instance refresh for ${autoScalingGroupName}`)
      }
    } catch (error) {
      // A previous attempt can have submitted a refresh and died before persisting the version.
      // That refresh is the desired handoff, so treating this specific response as success makes
      // the operation retry-safe without cancelling or replacing a healthy rollout.
      if (!(error instanceof Error) || error.name !== "InstanceRefreshInProgressFault") throw error
    }
  }
}

export function reconcilePlatformEdgeCertificate(
  options?: Partial<PlatformCertificateDependencies>,
): JobHandler {
  return async (_job, { db, keepAlive }) => {
    const deps = dependencies(options)
    const config = platformCertificateConfig()
    await crudPlatformEdgeCertificate(db).ensure()
    const leaseToken = v7()
    const state = await crudPlatformEdgeCertificate(db).claimReconciliation(leaseToken)
    if (state === undefined) return
    let awaitingDeployment = false

    try {
      const directoryUrl = configuredAcmeDirectoryUrl()
      const provenanceMatches =
        state.certificateDirectoryUrl === directoryUrl &&
        state.certificateIssuer !== null &&
        state.renewalInfoCertificateId !== null
      awaitingDeployment = state.status === "awaiting_deployment" && provenanceMatches
      if (
        state.status === "awaiting_deployment" &&
        state.certificateObjectVersion !== null &&
        provenanceMatches
      ) {
        if (!config.rolloutEnabled) {
          await crudPlatformEdgeCertificate(db).update(leaseToken, {
            statusReason:
              "Certificate stored; waiting for PLATFORM_EDGE_ROLLOUT_ENABLED=1 before restarting routers.",
            nextRetryAt: new Date(deps.now().getTime() + 60_000),
          })
          return
        }
        if (state.restartRequestedObjectVersion !== state.certificateObjectVersion) {
          await requestPlatformRestart(deps.autoScaling, config)
          await crudPlatformEdgeCertificate(db).update(leaseToken, {
            restartRequestedObjectVersion: state.certificateObjectVersion,
          })
        }
        const quorum = await certificateDeploymentQuorum(
          deps.valkey,
          `cert:platform-loaded:${certificateVersionKey(state.certificateObjectVersion)}:`,
          deps.now(),
        )
        if (quorum.ready) {
          if (
            state.deployedObjectVersion !== null &&
            state.deployedObjectVersion !== state.certificateObjectVersion
          ) {
            await deps.s3.send(
              new DeleteObjectCommand({
                Bucket: config.bucket,
                Key: config.objectKey,
                VersionId: state.deployedObjectVersion,
              }),
            )
          }
          const nextRetryAt =
            state.nextRenewalAt === null
              ? (state.certificateExpiresAt ?? deps.now())
              : nextCertificateWorkAt({
                  nextRenewalAt: state.nextRenewalAt,
                  renewalInfoRetryAt: state.renewalInfoRetryAt,
                  renewalInfoExplanationUrl: state.renewalInfoExplanationUrl,
                  source: state.renewalInfoRetryAt === null ? "unsupported" : "ari",
                })
          await crudPlatformEdgeCertificate(db).update(leaseToken, {
            status: "active",
            statusReason: null,
            deployedObjectVersion: state.certificateObjectVersion,
            consecutiveFailures: 0,
            nextRetryAt,
          })
        } else {
          await crudPlatformEdgeCertificate(db).update(leaseToken, {
            statusReason: `Certificate stored; waiting for every serving router after the rolling restart (${quorum.loaded}/${quorum.serving} loaded this version).`,
            nextRetryAt: new Date(deps.now().getTime() + 60_000),
          })
        }
        return
      }

      const now = deps.now()
      if (provenanceMatches && state.nextRetryAt > now) return
      if (
        provenanceMatches &&
        state.status === "active" &&
        state.nextRenewalAt !== null &&
        state.nextRenewalAt > now
      ) {
        if (
          state.renewalInfoRetryAt !== null &&
          state.renewalInfoRetryAt <= now &&
          state.renewalInfoCertificateId !== null &&
          state.certificateExpiresAt !== null
        ) {
          const schedule = await deps.refreshRenewal({
            certificateId: state.renewalInfoCertificateId,
            directoryUrl,
            expiresAt: state.certificateExpiresAt,
            now,
          })
          await crudPlatformEdgeCertificate(db).update(leaseToken, {
            nextRenewalAt: schedule.nextRenewalAt,
            renewalInfoRetryAt: schedule.renewalInfoRetryAt,
            renewalInfoExplanationUrl: schedule.renewalInfoExplanationUrl,
            nextRetryAt: nextCertificateWorkAt(schedule),
          })
          if (schedule.nextRenewalAt > now) return
        } else {
          return
        }
      }

      await crudPlatformEdgeCertificate(db).update(leaseToken, {
        status: "issuing",
        statusReason:
          !provenanceMatches && state.certificateObjectVersion !== null
            ? "Replacing a platform certificate whose ACME issuer provenance does not match the configured directory."
            : state.deployedObjectVersion === null
              ? "Issuing the initial platform edge certificate."
              : "Renewing the platform edge certificate.",
        nextRetryAt: new Date(now.getTime() + 10 * 60_000),
      })

      let heartbeatFailed = false
      const heartbeat = setInterval(() => {
        void Promise.all([
          keepAlive(),
          crudPlatformEdgeCertificate(db).heartbeatReconciliation(leaseToken),
        ]).then((alive) => {
          if (alive.some((value) => !value)) heartbeatFailed = true
        })
      }, 60_000)
      let certificate: Certificate
      try {
        certificate = await deps.issue(deps, config)
      } finally {
        clearInterval(heartbeat)
      }
      if (heartbeatFailed)
        throw new Error("Lost the platform-certificate lease during ACME issuance")
      const renewal = await deps.scheduleIssued({
        certificatePem: certificate.certificatePem,
        directoryUrl,
        expiresAt: certificate.expiresAt,
        now: deps.now(),
      })

      const stored = await deps.s3.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: config.objectKey,
          Body: platformCertificateObject(config, certificate),
          ContentType: "application/json",
          ServerSideEncryption: "aws:kms",
          SSEKMSKeyId: config.kmsKeyArn,
        }),
      )
      if (stored.VersionId === undefined) {
        throw new Error("Certificate bucket versioning is not enabled; S3 returned no VersionId")
      }

      await crudPlatformEdgeCertificate(db).update(leaseToken, {
        status: "awaiting_deployment",
        statusReason: config.rolloutEnabled
          ? "Certificate issued; a rolling router restart is required."
          : "Certificate stored; waiting for PLATFORM_EDGE_ROLLOUT_ENABLED=1 before restarting routers.",
        certificateObjectKey: config.objectKey,
        certificateObjectVersion: stored.VersionId,
        certificateIssuer: renewal.issuer,
        certificateDirectoryUrl: directoryUrl,
        restartRequestedObjectVersion: null,
        certificateIssuedAt: certificate.issuedAt,
        certificateExpiresAt: certificate.expiresAt,
        renewalInfoCertificateId: renewal.certificateId,
        renewalInfoRetryAt: renewal.renewalInfoRetryAt,
        renewalInfoExplanationUrl: renewal.renewalInfoExplanationUrl,
        nextRenewalAt: renewal.nextRenewalAt,
        nextRetryAt: new Date(deps.now().getTime() + 60_000),
        consecutiveFailures: 0,
      })
      awaitingDeployment = true
      if (!config.rolloutEnabled) return
      await requestPlatformRestart(deps.autoScaling, config)
      await crudPlatformEdgeCertificate(db).update(leaseToken, {
        restartRequestedObjectVersion: stored.VersionId,
      })
    } catch (error) {
      const failures = state.consecutiveFailures + 1
      await crudPlatformEdgeCertificate(db).update(leaseToken, {
        status: awaitingDeployment
          ? "awaiting_deployment"
          : state.deployedObjectVersion === null
            ? "failed"
            : "renewal_warning",
        statusReason:
          error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
        consecutiveFailures: failures,
        nextRetryAt: retryAfter(deps.now(), failures),
      })
      throw error
    } finally {
      await crudPlatformEdgeCertificate(db).releaseReconciliation(leaseToken)
    }
  }
}
