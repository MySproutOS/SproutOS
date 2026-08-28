/* oxlint-disable no-await-in-loop -- provider checks are deliberately serialized for quota safety */
import { crudAndroidApp, fetchAndroidApp } from "@lib/dao"
import type { DB } from "@sproutos/db"
import type { Kysely } from "kysely"
import { createHash } from "node:crypto"
import {
  type AndroidRegistrationProviderState,
  recordDeveloperConsoleCheckFailure,
  recordDeveloperConsoleState,
} from "./apk-signing"
import type { JobHandler } from "./worker"

export const ANDROID_REGISTRATION_RECONCILE_KIND =
  "android.reconcile_developer_registration" as const
export const ANDROID_REGISTRATION_CLAIM_MS = 10 * 60 * 1000
export const ANDROID_REGISTRATION_BATCH_SIZE = 25
export const ANDROID_REGISTRATION_DAILY_LIMIT = 1000
export const ANDROID_REGISTRATION_REVALIDATE_MS = 7 * 24 * 60 * 60 * 1000
export const ANDROID_REGISTRATION_CIRCUIT_VERSION = "1"
const STATUS_ENDPOINT = "https://androiddeveloperidstatus.googleapis.com"

type ProviderFailureKind = "batch_terminal" | "quota" | "transient"
type TerminalFailureKind =
  | "invalid_argument"
  | "unauthenticated"
  | "permission_denied"
  | "provider_contract"

export class AndroidDeveloperStatusError extends Error {
  constructor(
    message: string,
    readonly kind: ProviderFailureKind,
    readonly status?: number,
    readonly terminalKind?: TerminalFailureKind,
  ) {
    super(message)
    this.name = "AndroidDeveloperStatusError"
  }
}

export interface AndroidDeveloperStatusChecker {
  check(packageName: string, certificateSha256: string): Promise<AndroidRegistrationProviderState>
}

type Fetch = typeof fetch

export class GoogleAndroidDeveloperStatusChecker implements AndroidDeveloperStatusChecker {
  constructor(
    private readonly apiKey: string,
    private readonly request: Fetch = fetch,
    private readonly endpoint: string = STATUS_ENDPOINT,
  ) {
    if (apiKey === "") throw new Error("Android Developer ID Status API key is empty")
  }

  async check(
    packageName: string,
    certificateSha256: string,
  ): Promise<AndroidRegistrationProviderState> {
    const url = new URL(
      `/v1/packages/${encodeURIComponent(packageName)}/packageRegistrationStatus:check`,
      this.endpoint,
    )
    url.searchParams.set("certificateFingerprint", certificateSha256)
    let response: Response
    try {
      response = await this.request(url, {
        method: "GET",
        headers: { "X-Goog-Api-Key": this.apiKey },
        signal: AbortSignal.timeout(15_000),
      })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      throw new AndroidDeveloperStatusError(
        `Android Developer ID Status API failed: ${message}`,
        "transient",
      )
    }
    if (!response.ok) {
      const kind: ProviderFailureKind =
        response.status === 429 ? "quota" : response.status >= 500 ? "transient" : "batch_terminal"
      throw new AndroidDeveloperStatusError(
        `Android Developer ID Status API returned HTTP ${response.status}`,
        kind,
        response.status,
        response.status === 400
          ? "invalid_argument"
          : response.status === 401
            ? "unauthenticated"
            : response.status === 403
              ? "permission_denied"
              : undefined,
      )
    }
    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new AndroidDeveloperStatusError(
        "Android Developer ID Status API returned invalid JSON",
        "batch_terminal",
        undefined,
        "provider_contract",
      )
    }
    if (typeof body !== "object" || body === null || !("state" in body)) {
      throw new AndroidDeveloperStatusError(
        "Android Developer ID Status API returned a malformed response",
        "batch_terminal",
        undefined,
        "provider_contract",
      )
    }
    const state = body.state
    if (
      state !== "NOT_REGISTERED" &&
      state !== "REGISTERED" &&
      state !== "REGISTERED_WITH_ANOTHER_CERTIFICATE_FINGERPRINT"
    ) {
      throw new AndroidDeveloperStatusError(
        "Android Developer ID Status API returned an unknown registration state",
        "batch_terminal",
        undefined,
        "provider_contract",
      )
    }
    return state
  }
}

function reviewDelay(attempts: number): number {
  return Math.min(6 * 60 * 60 * 1000, 15 * 60 * 1000 * 2 ** Math.min(attempts, 5))
}

function retryDelay(attempts: number): number {
  return Math.min(60 * 60 * 1000, 60 * 1000 * 2 ** Math.min(attempts, 6))
}

function failureKind(cause: unknown): ProviderFailureKind {
  return cause instanceof AndroidDeveloperStatusError ? cause.kind : "transient"
}

export function androidRegistrationConfigFingerprint(
  apiKey: string,
  circuitVersion = ANDROID_REGISTRATION_CIRCUIT_VERSION,
): string {
  return createHash("sha256")
    .update("android-developer-id-status:v1\0")
    .update(apiKey)
    .update("\0")
    .update(circuitVersion)
    .digest("hex")
}

export async function androidRegistrationQueueHealth(
  db: Kysely<DB>,
  now: Date = new Date(),
  androidAppIds?: string[],
) {
  return await fetchAndroidApp(db).registrationQueueHealth(now, androidAppIds)
}

export async function reconcileAndroidDeveloperRegistrations(
  db: Kysely<DB>,
  checker: AndroidDeveloperStatusChecker,
  input: {
    workerId: string
    configFingerprint: string
    now?: Date
    limit?: number
    androidAppIds?: string[]
  },
): Promise<{ claimed: number; registered: number; failed: number; circuitOpen: boolean }> {
  const now = input.now ?? new Date()
  const claimToken = input.workerId
  await crudAndroidApp(db).reconcilerSeen(now)
  try {
    const claim = await crudAndroidApp(db).claimDueRegistrations({
      claimToken,
      now,
      claimExpiresAt: new Date(now.getTime() + ANDROID_REGISTRATION_CLAIM_MS),
      limit: input.limit ?? ANDROID_REGISTRATION_BATCH_SIZE,
      dailyLimit: ANDROID_REGISTRATION_DAILY_LIMIT,
      configFingerprint: input.configFingerprint,
      androidAppIds: input.androidAppIds,
    })
    if (claim.circuitOpen) {
      return { claimed: 0, registered: 0, failed: 0, circuitOpen: true }
    }
    const registrations = claim.rows
    let registered = 0
    let failed = 0
    for (const registration of registrations) {
      try {
        const providerState = await checker.check(
          registration.packageName,
          registration.certificateSha256!,
        )
        const anotherCertificate =
          providerState === "REGISTERED_WITH_ANOTHER_CERTIFICATE_FINGERPRINT"
        const state =
          providerState === "REGISTERED"
            ? ("registered" as const)
            : anotherCertificate
              ? ("failed" as const)
              : ("pending_registration" as const)
        const recorded = await recordDeveloperConsoleState(db, {
          androidAppId: registration.id,
          claimToken,
          providerState,
          state,
          checkedAt: now,
          nextCheckAt: new Date(
            now.getTime() +
              (providerState === "REGISTERED"
                ? ANDROID_REGISTRATION_REVALIDATE_MS
                : reviewDelay(registration.developerConsoleCheckAttempts)),
          ),
          ...(anotherCertificate
            ? { error: "Package name is registered with another signing certificate" }
            : {}),
        })
        if (!recorded) continue
        if (providerState === "REGISTERED") registered += 1
        if (anotherCertificate) failed += 1
      } catch (cause) {
        const failure = cause instanceof Error ? cause.message : String(cause)
        const kind = failureKind(cause)
        const recorded = await recordDeveloperConsoleCheckFailure(db, {
          androidAppId: registration.id,
          claimToken,
          checkedAt: now,
          nextCheckAt: new Date(
            now.getTime() + retryDelay(registration.developerConsoleCheckAttempts),
          ),
          error: failure,
        })
        if (recorded) failed += 1
        if (kind === "batch_terminal" || kind === "quota") {
          await crudAndroidApp(db).releaseRegistrationClaims(claimToken, now)
          if (kind === "batch_terminal") {
            const terminalKind =
              cause instanceof AndroidDeveloperStatusError
                ? (cause.terminalKind ?? "provider_contract")
                : "provider_contract"
            await crudAndroidApp(db).reconcilerTerminalFailed({
              now,
              failure,
              failureKind: terminalKind,
              configFingerprint: input.configFingerprint,
            })
            return {
              claimed: registrations.length,
              registered,
              failed,
              circuitOpen: true,
            }
          }
          await crudAndroidApp(db).reconcilerFailed(now, failure)
          throw cause
        }
      }
    }
    await crudAndroidApp(db).reconcilerCompleted(
      now,
      failed > 0 ? `${failed} Android registration provider check(s) failed` : null,
      registrations.length > 0 && failed === 0,
    )
    return { claimed: registrations.length, registered, failed, circuitOpen: false }
  } catch (cause) {
    const failure = cause instanceof Error ? cause.message : String(cause)
    await crudAndroidApp(db)
      .releaseRegistrationClaims(claimToken, now)
      .catch(() => undefined)
    await crudAndroidApp(db)
      .reconcilerFailed(now, failure)
      .catch(() => undefined)
    throw cause
  }
}

export function reconcileAndroidDeveloperRegistrationsJob(
  checker?: AndroidDeveloperStatusChecker,
): JobHandler {
  return async (job, { db }) => {
    const apiKey = process.env.ANDROID_DEVELOPER_ID_STATUS_API_KEY
    const provider =
      checker ??
      (apiKey === undefined || apiKey === ""
        ? undefined
        : new GoogleAndroidDeveloperStatusChecker(apiKey))
    if (provider === undefined) {
      throw new Error("ANDROID_DEVELOPER_ID_STATUS_API_KEY is not configured")
    }
    const result = await reconcileAndroidDeveloperRegistrations(db, provider, {
      workerId: `background-job:${job.id}`,
      configFingerprint: androidRegistrationConfigFingerprint(
        apiKey ?? "injected-checker",
        ANDROID_REGISTRATION_CIRCUIT_VERSION,
      ),
    })
    console.info(
      `[android-registration] claimed=${result.claimed} registered=${result.registered} failed=${result.failed} circuit_open=${result.circuitOpen}`,
    )
  }
}
