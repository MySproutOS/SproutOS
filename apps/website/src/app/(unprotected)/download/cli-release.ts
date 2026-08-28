const TARGETS = [
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "aarch64-unknown-linux-gnu",
  "x86_64-unknown-linux-gnu",
  "x86_64-pc-windows-msvc",
] as const

export type CliReleaseAsset = {
  target: (typeof TARGETS)[number]
  os: string
  arch: string
  url: string
  sha256: string
  sizeBytes: number
}

export type CliReleaseManifest = {
  schemaVersion: 1
  version: string
  tag: string
  assets: CliReleaseAsset[]
}

export function cliManifestUrl(version: string): string | null {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) return null
  const tag = `cli-v${version}`
  return `https://github.com/MySproutOS/SproutOS/releases/download/${tag}/sprout-v${version}-manifest.json`
}

export function parseCliReleaseManifest(
  value: unknown,
  configuredVersion: string,
): CliReleaseManifest {
  if (typeof value !== "object" || value === null) throw new Error("Invalid CLI release manifest")
  const manifest = value as Partial<CliReleaseManifest>
  const tag = `cli-v${configuredVersion}`
  const assetPrefix = `https://github.com/MySproutOS/SproutOS/releases/download/${tag}/`
  if (
    manifest.schemaVersion !== 1 ||
    manifest.version !== configuredVersion ||
    manifest.tag !== tag ||
    !Array.isArray(manifest.assets) ||
    manifest.assets.length !== TARGETS.length
  ) {
    throw new Error("Invalid CLI release manifest")
  }

  const byTarget = new Map(manifest.assets.map((asset) => [asset.target, asset]))
  for (const target of TARGETS) {
    const asset = byTarget.get(target)
    if (
      asset === undefined ||
      !asset.url.startsWith(assetPrefix) ||
      !/^[0-9a-f]{64}$/.test(asset.sha256) ||
      !Number.isSafeInteger(asset.sizeBytes) ||
      asset.sizeBytes <= 0 ||
      asset.os.length === 0 ||
      asset.arch.length === 0
    ) {
      throw new Error("Invalid CLI release manifest")
    }
  }

  if (byTarget.size !== TARGETS.length) throw new Error("Invalid CLI release manifest")
  return manifest as CliReleaseManifest
}

export async function latestCliRelease(): Promise<CliReleaseManifest | null> {
  const version = process.env.SPROUT_CLI_RELEASE_VERSION
  if (version === undefined || version === "") return null
  const url = cliManifestUrl(version)
  if (url === null) throw new Error("SPROUT_CLI_RELEASE_VERSION is invalid")

  const response = await fetch(url, { next: { revalidate: 3600 } })
  if (!response.ok) throw new Error(`CLI release lookup failed with status ${response.status}`)
  return parseCliReleaseManifest(await response.json(), version)
}
