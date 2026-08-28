/**
 * The catalogue the SproutOS Android client reads (§11.3).
 *
 * ## Not F-Droid's format
 *
 * The brief calls this "an F-Droid server alternative", and the temptation is to emit F-Droid's
 * `index-v2.json` so their client could read it too. That is the wrong trade here:
 *
 * - The client is ours. Nothing else consumes this, so compatibility buys nothing today.
 * - F-Droid's index describes a **public** repository of **apps**. This one has to carry a personal
 *   section, and websites alongside apps — neither of which has anywhere to go in their schema.
 * - Their index is signed with a JAR signature over the whole file. Our APKs are private and reached
 *   through signed URLs that expire, so a signed static index would be describing artefacts the
 *   reader may not be allowed to fetch.
 *
 * So this is a small format of our own, and the reason is written down rather than left as an
 * apparent oversight.
 *
 * ## Public and personal
 *
 * Two sections, matching the client's two tabs. What separates them is not a flag on the app but
 * *who is asking*: the personal section is built from the caller's own organizations, so an
 * unauthenticated request gets a catalogue with an empty personal half rather than an error.
 */

export type AndroidApp = {
  /** Stable database identity for this application. */
  androidAppId: string
  /** The project whose entitlement controls this private APK. */
  projectId: string
  /** The Android package name. The client's primary key, and what an install replaces. */
  packageName: string
  label: string
  summary: string
  versionName: string
  /** Android's own monotonic version. An install refuses to downgrade, so this must only rise. */
  versionCode: number
  /** sha256 of the signed APK, so the client can verify what it downloaded. */
  sha256: string
  sizeBytes: number
  certificateSha256: string
  /** Expiring. See `catalogueTtlSeconds`. */
  downloadUrl: string
  iconUrl?: string
}

export type ClientUpdate = {
  packageName: "com.sproutos.store"
  versionName: string
  versionCode: number
  sha256: string
  sizeBytes: number
  certificateSha256: string
  downloadUrl: string
  required?: boolean
}

export type AndroidSite = {
  /** A website in the personal tab: something the customer deployed that has no APK. */
  name: string
  url: string
  summary: string
}

export type Catalogue = {
  /** Bumped when the shape changes, so an old client can refuse rather than misread. */
  version: 2
  generatedAt: string
  /** Expires with the download URLs inside it. */
  expiresAt: string
  public: { apps: AndroidApp[] }
  personal: { apps: AndroidApp[]; sites: AndroidSite[] }
  /** Present only after a verified SproutOS client release has been published. */
  clientUpdate?: ClientUpdate
}

/**
 * How long a catalogue and the URLs inside it are good for.
 *
 * The two must match. A catalogue cached longer than its URLs is a list of buttons that fail; URLs
 * that outlive the catalogue are links that survive a revocation. An hour is long enough that a
 * client on a train can browse and install, and short enough that a removed app stops being
 * reachable within a working session.
 */
export const CATALOGUE_TTL_SECONDS = 3600

export function catalogueTtlSeconds(): number {
  return CATALOGUE_TTL_SECONDS
}

/**
 * Whether a client understands this catalogue.
 *
 * Checked by the client before reading. A newer catalogue read by an older client would be
 * *partially* understood — the dangerous kind of incompatibility, where a missing personal section
 * looks like an empty one and a customer concludes their apps are gone.
 */
export function isReadable(version: number): boolean {
  return version === 2
}

export type AppRow = {
  androidAppId: string
  projectId: string
  packageName: string | null
  label: string
  summary: string | null
  versionName: string | null
  versionCode: number | null
  sha256: string | null
  sizeBytes: number | null
  signedKey: string | null
  signedObjectVersion: string | null
  certificateSha256: string | null
  iconUrl: string | null
}

/**
 * Turn a stored row into a catalogue entry, or nothing.
 *
 * A deployment that has not been signed yet has no `signedKey`, and an unsigned APK must never
 * appear: Android will refuse to install it, and the customer sees a download that fails rather
 * than an app that is not ready. Same for the digest — an entry the client cannot verify is an
 * entry it should not have been offered.
 */
export function toApp(row: AppRow, signedUrlFor: (key: string) => string): AndroidApp | undefined {
  if (
    row.packageName === null ||
    row.signedKey === null ||
    row.signedObjectVersion === null ||
    row.sha256 === null ||
    row.versionCode === null ||
    row.versionName === null ||
    row.sizeBytes === null ||
    row.certificateSha256 === null
  ) {
    return undefined
  }

  return {
    androidAppId: row.androidAppId,
    projectId: row.projectId,
    packageName: row.packageName,
    label: row.label,
    summary: row.summary ?? "",
    versionName: row.versionName,
    versionCode: row.versionCode,
    sha256: row.sha256,
    sizeBytes: row.sizeBytes,
    certificateSha256: row.certificateSha256,
    downloadUrl: signedUrlFor(row.signedKey),
    ...(row.iconUrl === null ? {} : { iconUrl: row.iconUrl }),
  }
}

/**
 * One entry per package: the highest `versionCode`.
 *
 * A catalogue listing three versions of one app makes the client choose, and Android refuses to
 * install a lower version code over a higher one — so offering an older build is offering an
 * install that fails with a message about the app already being installed.
 */
export function latestPerPackage(apps: AndroidApp[]): AndroidApp[] {
  const best = new Map<string, AndroidApp>()

  for (const app of apps) {
    const existing = best.get(app.packageName)
    if (existing === undefined || app.versionCode > existing.versionCode) {
      best.set(app.packageName, app)
    }
  }

  // Sorted by label so the client does not have to, and so two requests return the same order.
  return [...best.values()].toSorted((a, b) => a.label.localeCompare(b.label))
}

export function buildCatalogue(input: {
  publicApps: AndroidApp[]
  personalApps: AndroidApp[]
  personalSites: AndroidSite[]
  clientUpdate?: ClientUpdate
  now?: Date
}): Catalogue {
  const now = input.now ?? new Date()

  return {
    version: 2,
    generatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + CATALOGUE_TTL_SECONDS * 1000).toISOString(),
    public: { apps: latestPerPackage(input.publicApps) },
    personal: {
      apps: latestPerPackage(input.personalApps),
      sites: [...input.personalSites].toSorted((a, b) => a.name.localeCompare(b.name)),
    },
    ...(input.clientUpdate === undefined ? {} : { clientUpdate: input.clientUpdate }),
  }
}

export type ClientReleaseRow = {
  packageName: string
  versionName: string
  versionCode: number
  sha256: string
  sizeBytes: number
  certificateSha256: string
  objectKey: string
  required: boolean
}

/** Convert a persisted platform release into the contract shared with the Android client. */
export function toClientUpdate(
  row: ClientReleaseRow,
  signedUrlFor: (key: string) => string,
): ClientUpdate | undefined {
  if (
    row.packageName !== "com.sproutos.store" ||
    row.versionName.length === 0 ||
    !Number.isInteger(row.versionCode) ||
    row.versionCode <= 0 ||
    row.versionCode > 2_100_000_000 ||
    !Number.isSafeInteger(row.sizeBytes) ||
    row.sizeBytes <= 0 ||
    !/^[0-9a-f]{64}$/.test(row.sha256) ||
    !/^[0-9a-f]{64}$/.test(row.certificateSha256) ||
    row.objectKey.length === 0
  ) {
    return undefined
  }

  return {
    packageName: row.packageName,
    versionName: row.versionName,
    versionCode: row.versionCode,
    sha256: row.sha256,
    sizeBytes: row.sizeBytes,
    certificateSha256: row.certificateSha256,
    downloadUrl: signedUrlFor(row.objectKey),
    ...(row.required ? { required: true } : {}),
  }
}
