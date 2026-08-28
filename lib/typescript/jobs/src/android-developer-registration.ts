/* oxlint-disable no-await-in-loop -- provider checks are deliberately serialized for quota safety */
import {
  type AndroidRegistrationProviderState,
  crudAndroidDeveloperRegistration,
  fetchAndroidDeveloperRegistration,
} from "@lib/dao"
import type { DB } from "@sproutos/db"
import type { Kysely } from "kysely"
import type { JobHandler } from "./worker"

export const ANDROID_REGISTRATION_RECONCILE_KIND =
  "android.reconcile_developer_registration" as const
export const ANDROID_REGISTRATION_CLAIM_MS = 10 * 60 * 1000
export const ANDROID_REGISTRATION_BATCH_SIZE = 25
const STATUS_ENDPOINT = "https://androiddeveloperidstatus.googleapis.com"

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
    const response = await this.request(url, {
      method: "GET",
      headers: { "X-Goog-Api-Key": this.apiKey },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) {
      throw new Error(`Android Developer ID Status API returned HTTP ${response.status}`)
    }
    const body: unknown = await response.json()
    if (typeof body !== "object" || body === null || !("state" in body)) {
      throw new Error("Android Developer ID Status API returned a malformed response")
    }
    const state = body.state
    if (
      state !== "NOT_REGISTERED" &&
      state !== "REGISTERED" &&
      state !== "REGISTERED_WITH_ANOTHER_CERTIFICATE_FINGERPRINT"
    ) {
      throw new Error("Android Developer ID Status API returned an unknown registration state")
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

export async function ensureAndroidDeveloperRegistration(
  db: Kysely<DB>,
  input: { projectId: string; packageName: string; certificateSha256: string },
) {
  return await crudAndroidDeveloperRegistration(db).ensure(input)
}

export async function verifyAndroidSetupCommit(
  db: Kysely<DB>,
  projectId: string,
  commit: string,
): Promise<boolean> {
  return await crudAndroidDeveloperRegistration(db).verifySetupCommit(projectId, commit)
}

export async function androidRegistrationQueueHealth(db: Kysely<DB>, now: Date = new Date()) {
  return await fetchAndroidDeveloperRegistration(db).queueHealth(now)
}

export async function reconcileAndroidDeveloperRegistrations(
  db: Kysely<DB>,
  checker: AndroidDeveloperStatusChecker,
  input: { workerId: string; now?: Date; limit?: number },
): Promise<{ claimed: number; registered: number; failed: number }> {
  const now = input.now ?? new Date()
  await crudAndroidDeveloperRegistration(db).reconcilerSeen(now)
  try {
    const registrations = await crudAndroidDeveloperRegistration(db).claimDue(input.workerId, {
      now,
      staleBefore: new Date(now.getTime() - ANDROID_REGISTRATION_CLAIM_MS),
      limit: input.limit ?? ANDROID_REGISTRATION_BATCH_SIZE,
    })
    let registered = 0
    let failed = 0
    for (const registration of registrations) {
      try {
        const providerState = await checker.check(
          registration.packageName,
          registration.certificateSha256,
        )
        const anotherCertificate =
          providerState === "REGISTERED_WITH_ANOTHER_CERTIFICATE_FINGERPRINT"
        const recorded = await crudAndroidDeveloperRegistration(db).recordProviderState({
          id: registration.id,
          workerId: input.workerId,
          providerState,
          checkedAt: now,
          nextCheckAt: new Date(now.getTime() + reviewDelay(registration.checkAttempts)),
          ...(anotherCertificate
            ? { failure: "Package name is registered with another signing certificate" }
            : {}),
        })
        if (!recorded) continue
        if (providerState === "REGISTERED") {
          registered += 1
        } else if (anotherCertificate) {
          failed += 1
        }
      } catch (cause) {
        const failure = cause instanceof Error ? cause.message : String(cause)
        const recorded = await crudAndroidDeveloperRegistration(db).recordCheckFailure({
          id: registration.id,
          workerId: input.workerId,
          checkedAt: now,
          nextCheckAt: new Date(now.getTime() + retryDelay(registration.checkAttempts)),
          failure,
        })
        if (recorded) failed += 1
      }
    }
    await crudAndroidDeveloperRegistration(db).reconcilerCompleted(now)
    return { claimed: registrations.length, registered, failed }
  } catch (cause) {
    const failure = cause instanceof Error ? cause.message : String(cause)
    await crudAndroidDeveloperRegistration(db)
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
    })
    console.info(
      `[android-registration] claimed=${result.claimed} registered=${result.registered} failed=${result.failed}`,
    )
  }
}
