export type AndroidClientRelease = {
  packageName: "com.sproutos.store"
  versionName: string
  versionCode: number
  sha256: string
  sizeBytes: number
  certificateSha256: string
  downloadUrl: string
  required?: boolean
}

export function parseAndroidClientRelease(value: unknown): AndroidClientRelease {
  if (typeof value !== "object" || value === null) throw new Error("Invalid Android client release")
  const release = value as Partial<AndroidClientRelease>
  let download: URL
  try {
    download = new URL(release.downloadUrl ?? "")
  } catch {
    throw new Error("Invalid Android client release")
  }
  if (
    release.packageName !== "com.sproutos.store" ||
    typeof release.versionName !== "string" ||
    release.versionName.length === 0 ||
    !Number.isInteger(release.versionCode) ||
    release.versionCode! <= 0 ||
    release.versionCode! > 2_100_000_000 ||
    typeof release.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(release.sha256) ||
    !Number.isSafeInteger(release.sizeBytes) ||
    release.sizeBytes! <= 0 ||
    typeof release.certificateSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(release.certificateSha256) ||
    download.protocol !== "https:" ||
    download.hostname === "" ||
    (release.required !== undefined && typeof release.required !== "boolean")
  ) {
    throw new Error("Invalid Android client release")
  }
  return release as AndroidClientRelease
}

export async function latestAndroidClientRelease(
  fetchRelease: typeof fetch = fetch,
): Promise<AndroidClientRelease | null> {
  const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001"
  const response = await fetchRelease(`${apiBase}/v1/android/client-release`, {
    cache: "no-store",
  })
  if (response.status === 404) return null
  if (!response.ok) {
    throw new Error(`Android client release lookup failed with status ${response.status}`)
  }
  return parseAndroidClientRelease(await response.json())
}
