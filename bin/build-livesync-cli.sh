#!/usr/bin/env bash
# Build `obsidian-livesync`'s CLI, so `livesync-vault.test.ts` can drive the real client.
#
# The plugin is the reason object storage is a backend service here, and "it should work with
# livesync" is a claim worth checking against livesync rather than against a reading of its source.
# Its CLI is the only headless client it ships.
#
# Not vendored and not a dependency: it is a 1,000-package npm tree belonging to somebody else, and
# pinning it into this workspace would mean carrying their upgrades. The test skips when it is
# absent, and says so.
#
#   bin/build-livesync-cli.sh            # clone + build into the scratch directory
#   LIVESYNC_CLI=<path> pnpm test        # or point at one you already have
set -euo pipefail

target="${1:-${TMPDIR:-/tmp}/sproutos-livesync}"
ref="${LIVESYNC_REF:-main}"

if [ ! -d "$target/.git" ]; then
  echo "cloning obsidian-livesync into $target"
  git clone --depth 1 --branch "$ref" https://github.com/vrtmrz/obsidian-livesync.git "$target"
fi

cd "$target"
npm install --no-audit --no-fund
npm run build --workspace self-hosted-livesync-cli

bundle="$target/src/apps/cli/dist/index.cjs"
if [ ! -f "$bundle" ]; then
  echo "the build produced no bundle at $bundle" >&2
  exit 1
fi

echo
echo "built. To run the vault suite:"
echo "  LIVESYNC_CLI=$bundle pnpm --filter=@lib/services test"
