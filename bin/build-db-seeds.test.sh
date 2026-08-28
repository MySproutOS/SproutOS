#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT

"$repo_root/bin/build-db-seeds.sh" "$test_dir"

source_count="$(find "$repo_root/apps/dbmigrator/src/seeds" -maxdepth 1 -type f -name '*.ts' | wc -l | tr -d ' ')"
artifact_count="$(find "$test_dir" -maxdepth 1 -type f -name '*.js' | wc -l | tr -d ' ')"
test "$artifact_count" = "$source_count"

if rg -n --glob '*.js' '^(import|export).*(@lib/|node_modules/[^" ]+\.ts)' "$test_dir"; then
  echo "seed artifact retained a workspace TypeScript import" >&2
  exit 1
fi

for artifact in "$test_dir"/*.js; do
  node --input-type=module --eval \
    'import { pathToFileURL } from "node:url"; await import(pathToFileURL(process.argv[1]).href)' \
    "$artifact"
done

echo "database seed artifacts are self-contained and importable"
