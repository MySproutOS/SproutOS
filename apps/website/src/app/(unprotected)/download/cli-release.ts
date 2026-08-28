const TARGETS = [
  {
    target: "aarch64-apple-darwin",
    os: "macos",
    arch: "arm64",
    suffix: "tar.gz",
  },
  {
    target: "x86_64-apple-darwin",
    os: "macos",
    arch: "x86_64",
    suffix: "tar.gz",
  },
  {
    target: "aarch64-unknown-linux-gnu",
    os: "linux",
    arch: "arm64",
    suffix: "tar.gz",
  },
  {
    target: "x86_64-unknown-linux-gnu",
    os: "linux",
    arch: "x86_64",
    suffix: "tar.gz",
  },
  {
    target: "x86_64-pc-windows-msvc",
    os: "windows",
    arch: "x86_64",
    suffix: "zip",
  },
] as const

type CliTarget = (typeof TARGETS)[number]

export type CliReleaseAsset = {
  target: CliTarget["target"]
  os: CliTarget["os"]
  arch: CliTarget["arch"]
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

export function cliPlatformLabel(asset: CliReleaseAsset): string {
  const os = asset.os === "macos" ? "macOS" : asset.os === "linux" ? "Linux" : "Windows"
  const arch = asset.arch === "x86_64" ? "x86-64" : asset.arch
  return `${os} ${arch}`
}

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

export function cliManifestUrl(version: string): string | null {
  if (!SEMVER.test(version)) return null
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
  if (
    manifest.schemaVersion !== 1 ||
    manifest.version !== configuredVersion ||
    manifest.tag !== tag ||
    !Array.isArray(manifest.assets) ||
    manifest.assets.length !== TARGETS.length
  ) {
    throw new Error("Invalid CLI release manifest")
  }

  const assetsByTarget = new Map(manifest.assets.map((asset) => [asset.target, asset]))
  for (const expected of TARGETS) {
    const asset = assetsByTarget.get(expected.target)
    const expectedUrl =
      `https://github.com/MySproutOS/SproutOS/releases/download/${tag}/` +
      `sprout-v${configuredVersion}-${expected.target}.${expected.suffix}`
    if (
      asset === undefined ||
      asset.os !== expected.os ||
      asset.arch !== expected.arch ||
      asset.url !== expectedUrl ||
      !/^[0-9a-f]{64}$/.test(asset.sha256) ||
      !Number.isSafeInteger(asset.sizeBytes) ||
      asset.sizeBytes <= 0
    ) {
      throw new Error("Invalid CLI release manifest")
    }
  }

  if (assetsByTarget.size !== TARGETS.length) throw new Error("Invalid CLI release manifest")
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
