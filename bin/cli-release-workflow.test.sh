#!/usr/bin/env bash
# Static release invariant: `gh release create --verify-tag` asks Git to verify the tag in the
# current repository, so the publish job must check out the tagged repository first.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORKFLOW=${CLI_RELEASE_WORKFLOW:-"$ROOT/.github/workflows/cli-release.yml"}

release_job=$(awk '
  /^  release:$/ { in_release=1; print; next }
  in_release && /^  [[:alnum:]_-]+:$/ { exit }
  in_release { print }
' "$WORKFLOW")

test "$(grep -c 'uses: actions/checkout@v5' <<<"$release_job" || true)" -eq 1
test "$(grep -c 'gh release create' <<<"$release_job" || true)" -eq 1
test "$(grep -c -- '--verify-tag' <<<"$release_job" || true)" -eq 1

checkout_line=$(grep -n 'uses: actions/checkout@v5' <<<"$release_job" | cut -d: -f1)
create_line=$(grep -n 'gh release create' <<<"$release_job" | cut -d: -f1)
verify_line=$(grep -n -- '--verify-tag' <<<"$release_job" | cut -d: -f1)

test "$checkout_line" -lt "$create_line"
test "$create_line" -lt "$verify_line"
# The workflow must pass the literal Actions environment variable to gh.
# shellcheck disable=SC2016
grep -q 'gh release create "$TAG" dist/\*' <<<"$release_job"

# Manifest v1 is already public. Keep the generator on its published four-field contract; source
# identity belongs to the independently verified tag-bound attestations, not mutable manifest text.
grep -Fq "'{schemaVersion:1,version:\$version,tag:\$tag,assets:\$assets}'" "$WORKFLOW"
# shellcheck disable=SC2016
if grep -Fq 'commitSha:$commitSha' "$WORKFLOW"; then
  echo "manifest v1 gained an unpublished top-level field" >&2
  exit 1
fi

echo "CLI release workflow tests passed"
