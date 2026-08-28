import { AuthorityKeyIdentifierExtension, X509Certificate } from "@peculiar/x509"
import * as acme from "acme-client"

const FALLBACK_RENEWAL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000
const ARI_ERROR_RETRY_MS = 6 * 60 * 60 * 1000
const MIN_ARI_RETRY_MS = 60_000
const MAX_ARI_RETRY_MS = 24 * 60 * 60 * 1000
const MAX_ACME_JSON_BYTES = 64 * 1024
const ACME_FETCH_TIMEOUT_MS = 10_000

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>

export type CertificateProvenance = {
  certificateId: string
  issuer: string
}

export type RenewalSchedule = {
  nextRenewalAt: Date
  renewalInfoRetryAt: Date | null
  renewalInfoExplanationUrl: string | null
  source: "ari" | "fallback" | "unsupported"
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url")
}

function bytesFromHex(hex: string, name: string): Uint8Array {
  if (hex === "" || hex.length % 2 !== 0 || !/^[\da-f]+$/i.test(hex)) {
    throw new Error(`${name} is not valid hexadecimal DER data`)
  }
  return Buffer.from(hex, "hex")
}

/** RFC 9773 section 4.1's AKI.Serial identifier for an issued leaf certificate. */
export function certificateProvenance(certificatePem: string): CertificateProvenance {
  const certificate = new X509Certificate(certificatePem)
  const authority = certificate.getExtension(AuthorityKeyIdentifierExtension)
  if (authority?.keyId === undefined || authority.keyId === "") {
    throw new Error("The issued certificate has no Authority Key Identifier keyIdentifier")
  }

  const authorityKeyIdentifier = bytesFromHex(authority.keyId, "Authority Key Identifier")
  let serial = bytesFromHex(certificate.serialNumber, "certificate serial number")
  // X509Certificate exposes the positive integer as hex and omits DER's sign-protecting zero.
  // RFC 9773 identifies the exact DER INTEGER contents, so restore that byte when bit 8 is set.
  if ((serial[0] & 0x80) !== 0) serial = Buffer.concat([Buffer.of(0), serial])

  return {
    certificateId: `${base64url(authorityKeyIdentifier)}.${base64url(serial)}`,
    issuer: certificate.issuer,
  }
}

export function fallbackRenewal(expiresAt: Date): Date {
  return new Date(expiresAt.getTime() - FALLBACK_RENEWAL_WINDOW_MS)
}

export function configuredAcmeDirectoryUrl(): string {
  const configured = process.env.ACME_DIRECTORY_URL ?? acme.directory.letsencrypt.staging
  const url = new URL(configured)
  if (url.protocol !== "https:") throw new Error("ACME_DIRECTORY_URL must use HTTPS")
  url.hash = ""
  return url.href
}

function parseObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} is not a JSON object`)
  }
  return value as Record<string, unknown>
}

async function json(response: Response, name: string): Promise<Record<string, unknown>> {
  if (!response.ok) throw new Error(`${name} returned HTTP ${response.status}`)
  const body = await response.text()
  if (Buffer.byteLength(body) > MAX_ACME_JSON_BYTES) {
    throw new Error(`${name} response exceeds 64 KiB`)
  }
  try {
    return parseObject(JSON.parse(body), name)
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith(name)) throw cause
    throw new Error(`${name} returned invalid JSON`, { cause })
  }
}

function rfc3339(value: unknown, name: string): Date {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  ) {
    throw new Error(`${name} is not an RFC 3339 timestamp`)
  }
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${name} is not a valid timestamp`)
  return parsed
}

export function retryAfterAt(value: string | null, now: Date): Date {
  if (value === null || value.trim() === "") throw new Error("ARI Retry-After is missing")
  const trimmed = value.trim()
  const requested = /^\d+$/.test(trimmed)
    ? Number(trimmed) * 1000
    : Date.parse(trimmed) - now.getTime()
  if (!Number.isFinite(requested)) throw new Error("ARI Retry-After is invalid")
  return new Date(now.getTime() + Math.min(MAX_ARI_RETRY_MS, Math.max(MIN_ARI_RETRY_MS, requested)))
}

function fallbackSchedule(expiresAt: Date, now: Date, retry: boolean): RenewalSchedule {
  return {
    nextRenewalAt: fallbackRenewal(expiresAt),
    renewalInfoRetryAt:
      retry && now < expiresAt ? new Date(now.getTime() + ARI_ERROR_RETRY_MS) : null,
    renewalInfoExplanationUrl: null,
    source: "fallback",
  }
}

function renewalInfoUrl(base: string, certificateId: string): string {
  const endpoint = new URL(base)
  if (endpoint.protocol !== "https:") throw new Error("ACME renewalInfo URL must use HTTPS")
  endpoint.hash = ""
  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, "")}/${certificateId}`
  return endpoint.href
}

/**
 * Refresh one RFC 9773 recommendation. Any unavailable or invalid ARI response degrades to the
 * bounded expiry-derived schedule; certificate issuance must not fail because this optional ACME
 * extension is unavailable.
 */
export async function refreshRenewalSchedule(options: {
  certificateId: string
  directoryUrl: string
  expiresAt: Date
  now: Date
  fetch?: Fetch
  random?: () => number
}): Promise<RenewalSchedule> {
  const fetcher = options.fetch ?? fetch
  const random = options.random ?? Math.random
  if (options.now >= options.expiresAt)
    return fallbackSchedule(options.expiresAt, options.now, false)

  try {
    const directoryUrl = new URL(options.directoryUrl)
    if (directoryUrl.protocol !== "https:") throw new Error("ACME directory URL must use HTTPS")
    const directoryResponse = await fetcher(directoryUrl, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(ACME_FETCH_TIMEOUT_MS),
    })
    const directory = await json(directoryResponse, "ACME directory")
    if (directory.renewalInfo === undefined) {
      return { ...fallbackSchedule(options.expiresAt, options.now, false), source: "unsupported" }
    }
    if (typeof directory.renewalInfo !== "string") {
      throw new Error("ACME directory renewalInfo is not a URL")
    }

    const response = await fetcher(renewalInfoUrl(directory.renewalInfo, options.certificateId), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(ACME_FETCH_TIMEOUT_MS),
    })
    const information = await json(response, "ACME renewalInfo")
    const window = parseObject(information.suggestedWindow, "ARI suggestedWindow")
    const start = rfc3339(window.start, "ARI suggestedWindow.start")
    const end = rfc3339(window.end, "ARI suggestedWindow.end")
    if (end <= start) throw new Error("ARI suggestedWindow must end after it starts")
    const sample = random()
    if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
      throw new Error("ARI random source returned a value outside [0, 1)")
    }

    const selected = new Date(
      start.getTime() + Math.floor((end.getTime() - start.getTime()) * sample),
    )
    const safetyFallback = fallbackRenewal(options.expiresAt)
    const nextRenewalAt = new Date(
      Math.max(options.now.getTime(), Math.min(selected.getTime(), safetyFallback.getTime())),
    )
    const retryAt = retryAfterAt(response.headers.get("retry-after"), options.now)
    const explanation = information.explanationURL
    if (explanation !== undefined && typeof explanation !== "string") {
      throw new Error("ARI explanationURL is not a string")
    }

    return {
      nextRenewalAt,
      renewalInfoRetryAt: nextRenewalAt <= options.now ? null : retryAt,
      renewalInfoExplanationUrl: explanation ?? null,
      source: "ari",
    }
  } catch {
    return fallbackSchedule(options.expiresAt, options.now, true)
  }
}

export async function scheduleIssuedCertificate(options: {
  certificatePem: string
  directoryUrl: string
  expiresAt: Date
  now: Date
  fetch?: Fetch
  random?: () => number
}): Promise<CertificateProvenance & RenewalSchedule> {
  const provenance = certificateProvenance(options.certificatePem)
  return {
    ...provenance,
    ...(await refreshRenewalSchedule({ ...options, certificateId: provenance.certificateId })),
  }
}
