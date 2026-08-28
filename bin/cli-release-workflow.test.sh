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

echo "CLI release workflow tests passed"
