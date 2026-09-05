import type { CliReleaseAsset, CliReleaseManifest } from "./cli-release"

function assetFor(release: CliReleaseManifest, target: CliReleaseAsset["target"]): CliReleaseAsset {
  const asset = release.assets.find((candidate) => candidate.target === target)
  if (asset === undefined) throw new Error(`CLI release is missing ${target}`)
  return asset
}

function caseEntry(os: string, machine: string, asset: CliReleaseAsset): string {
  return `  ${os}:${machine}) target='${asset.target}'; url='${asset.url}'; expected='${asset.sha256}' ;;`
}

/**
 * Render a self-contained installer for the exact release that passed production promotion.
 *
 * Values interpolated into this script have already passed the strict manifest parser: semantic
 * version, fixed target identifiers, exact GitHub release URLs, and lowercase SHA-256 digests.
 */
export function renderCliInstaller(release: CliReleaseManifest): string {
  const macArm = assetFor(release, "aarch64-apple-darwin")
  const macX64 = assetFor(release, "x86_64-apple-darwin")
  const linuxArm = assetFor(release, "aarch64-unknown-linux-gnu")
  const linuxX64 = assetFor(release, "x86_64-unknown-linux-gnu")

  return `#!/usr/bin/env bash
set -euo pipefail

version='${release.version}'

for required in awk curl grep install mktemp tar uname; do
  if ! command -v "$required" >/dev/null 2>&1; then
    echo "sprout installer requires $required" >&2
    exit 1
  fi
done

case "$(uname -s):$(uname -m)" in
${caseEntry("Darwin", "arm64", macArm)}
${caseEntry("Darwin", "x86_64", macX64)}
${caseEntry("Linux", "aarch64", linuxArm)}
${caseEntry("Linux", "arm64", linuxArm)}
${caseEntry("Linux", "x86_64", linuxX64)}
  *)
    echo "No Sprout CLI build is available for $(uname -s) $(uname -m)." >&2
    echo "Download another supported build from https://sproutos.me/download#sprout-cli" >&2
    exit 1
    ;;
esac

install_dir=\${SPROUT_INSTALL_DIR:-"\${HOME:?HOME is required}/.local/bin"}
work_dir=$(mktemp -d "\${TMPDIR:-/tmp}/sprout-install.XXXXXX")
cleanup() {
  find "$work_dir" -type f -exec unlink {} \\; 2>/dev/null || true
  find "$work_dir" -depth -type d -exec rmdir {} + 2>/dev/null || true
}
trap cleanup EXIT

archive="$work_dir/sprout.tar.gz"
curl --proto '=https' --tlsv1.2 --location --fail --silent --show-error \
  --retry 3 --retry-all-errors --output "$archive" "$url"

if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum --binary < "$archive" | awk '{ print $1 }')
elif command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 --binary < "$archive" | awk '{ print $1 }')
else
  echo "sprout installer requires sha256sum or shasum" >&2
  exit 1
fi

if [ "$actual" != "$expected" ]; then
  echo "Sprout CLI archive checksum did not match the promoted release." >&2
  exit 1
fi

tar -xzf "$archive" -C "$work_dir"
source_binary="$work_dir/sprout-v\${version}-\${target}/sprout"
if [ ! -f "$source_binary" ]; then
  echo "Sprout CLI archive did not contain its expected binary." >&2
  exit 1
fi

mkdir -p "$install_dir"
install -m 0755 "$source_binary" "$install_dir/sprout"
"$install_dir/sprout" --version | grep -Fx "sprout $version" >/dev/null

echo "Installed sprout $version to $install_dir/sprout"
case ":$PATH:" in
  *":$install_dir:"*) ;;
  *) echo "Add $install_dir to PATH to run sprout from any directory." ;;
esac
`
}
