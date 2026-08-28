#!/usr/bin/env bash
set -euo pipefail

output_dir="${1:?usage: build-db-seeds.sh OUTPUT_DIR}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
seed_dir="$repo_root/apps/dbmigrator/src/seeds"

mkdir -p "$output_dir"

for source in "$seed_dir"/*.ts; do
  filename="$(basename "$source")"
  output="$output_dir/${filename%.ts}.js"

  # Use the same workspace-aware bundler as the API and seed runner. `--packages=external`
  # externalises workspace packages too, leaving imports such as `@lib/oauth-provider` pointed at
  # TypeScript source under node_modules. Node 24 refuses to strip types there, which made the
  # production seed step fail after its migration had already committed.
  (
    cd "$repo_root/apps/dbmigrator"
    node ../internal-api/build.mjs "src/seeds/$filename" "$output"
  )
done
