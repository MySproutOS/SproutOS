#!/usr/bin/env bash
#
# Promote one already-published Sprout CLI release into the production website.
#
# This is intentionally not part of the build. It downloads the public release again, proves its
# immutable state, five-platform manifest, checksums and GitHub provenance, records that exact
# evidence under an append-only SSM path, and only then moves the small application pointer. ECS
# injects Parameter Store values at task start, so the final step replaces the website task.
#
# Usage: bin/promote-cli-release.sh <semver> [--record-only]
set -euo pipefail

VERSION=${1:-}
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$ ]]; then
  echo "usage: promote-cli-release.sh <semver>" >&2
  exit 2
fi
MODE=${2:-}
if [ -n "$MODE" ] && [ "$MODE" != --record-only ]; then
  echo "usage: promote-cli-release.sh <semver> [--record-only]" >&2
  exit 2
fi

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is not set}"
: "${NAME_PREFIX:?NAME_PREFIX is not set}"
: "${AWS_ACCOUNT_ID:?AWS_ACCOUNT_ID is not set}"
: "${AWS_REGION:?AWS_REGION is not set}"

if [ "$GITHUB_REPOSITORY" != "MySproutOS/SproutOS" ]; then
  echo "refusing to promote a release from $GITHUB_REPOSITORY" >&2
  exit 2
fi

TAG="cli-v${VERSION}"
CLUSTER=${ECS_CLUSTER:-$NAME_PREFIX}
SERVICE=${ECS_SERVICE:-$NAME_PREFIX-web}
POINTER="/${NAME_PREFIX}/application/SPROUT_CLI_RELEASE_VERSION"
RECORD="/${NAME_PREFIX}/releases/cli/${VERSION}"
POINTER_ARN="arn:aws:ssm:${AWS_REGION}:${AWS_ACCOUNT_ID}:parameter${POINTER}"
SIGNER_WORKFLOW="${GITHUB_REPOSITORY}/.github/workflows/cli-release.yml"

work_dir=$(mktemp -d)
cleanup() {
  find "$work_dir" -type f -exec unlink {} \; 2>/dev/null || true
  find "$work_dir" -depth -type d -exec rmdir {} + 2>/dev/null || true
}
trap cleanup EXIT

release_json=$(gh release view "$TAG" --repo "$GITHUB_REPOSITORY" \
  --json tagName,isDraft,isPrerelease,isImmutable)
jq -e --arg tag "$TAG" '
  .tagName == $tag and .isDraft == false and .isPrerelease == false and .isImmutable == true
' <<<"$release_json" >/dev/null || {
  echo "release $TAG is absent, mutable, a draft, or a prerelease" >&2
  exit 1
}

gh release download "$TAG" --repo "$GITHUB_REPOSITORY" --dir "$work_dir"

expected_assets=(
  "sprout-v${VERSION}-aarch64-apple-darwin.tar.gz"
  "sprout-v${VERSION}-x86_64-apple-darwin.tar.gz"
  "sprout-v${VERSION}-aarch64-unknown-linux-gnu.tar.gz"
  "sprout-v${VERSION}-x86_64-unknown-linux-gnu.tar.gz"
  "sprout-v${VERSION}-x86_64-pc-windows-msvc.zip"
)
expected_files=("${expected_assets[@]}" SHA256SUMS "sprout-v${VERSION}-manifest.json")

actual_files=$(find "$work_dir" -maxdepth 1 -type f -exec basename {} \; | LC_ALL=C sort)
sorted_expected=$(printf '%s\n' "${expected_files[@]}" | LC_ALL=C sort)
if ! diff -u <(printf '%s\n' "$sorted_expected") <(printf '%s\n' "$actual_files"); then
  echo "release $TAG does not contain exactly five native assets, SHA256SUMS and its manifest" >&2
  exit 1
fi

(cd "$work_dir" && sha256sum --check --strict SHA256SUMS)
checksum_names=$(sed -E 's/^[0-9a-f]{64}  //' "$work_dir/SHA256SUMS" | LC_ALL=C sort)
sorted_assets=$(printf '%s\n' "${expected_assets[@]}" | LC_ALL=C sort)
if ! diff -u <(printf '%s\n' "$sorted_assets") <(printf '%s\n' "$checksum_names"); then
  echo "SHA256SUMS does not name exactly the five native assets" >&2
  exit 1
fi

manifest="$work_dir/sprout-v${VERSION}-manifest.json"
jq -e --arg version "$VERSION" --arg tag "$TAG" '
  .schemaVersion == 1 and .version == $version and .tag == $tag and
  (.assets | type == "array" and length == 5) and
  ([.assets[].target] | sort) == ([
    "aarch64-apple-darwin",
    "aarch64-unknown-linux-gnu",
    "x86_64-apple-darwin",
    "x86_64-pc-windows-msvc",
    "x86_64-unknown-linux-gnu"
  ] | sort) and
  ([.assets[].target] | unique | length) == 5
' "$manifest" >/dev/null || {
  echo "release manifest has the wrong version, tag, schema, or platform set" >&2
  exit 1
}

for asset in "${expected_assets[@]}"; do
  target=${asset#"sprout-v${VERSION}-"}
  target=${target%.tar.gz}
  target=${target%.zip}
  sha256=$(sha256sum "$work_dir/$asset" | cut -d' ' -f1)
  size=$(wc -c <"$work_dir/$asset" | tr -d '[:space:]')
  url="https://github.com/${GITHUB_REPOSITORY}/releases/download/${TAG}/${asset}"
  jq -e --arg target "$target" --arg sha256 "$sha256" --argjson size "$size" --arg url "$url" '
    [.assets[] | select(
      .target == $target and .sha256 == $sha256 and .sizeBytes == $size and .url == $url and
      (.os | type == "string" and length > 0) and (.arch | type == "string" and length > 0)
    )] | length == 1
  ' "$manifest" >/dev/null || {
    echo "manifest metadata does not match downloaded asset $asset" >&2
    exit 1
  }
done

# Resolve the tag through Git rather than trusting mutable manifest text. With immutable releases
# enabled GitHub also locks this tag, and --source-ref/--source-digest bind every attestation to it.
git fetch --quiet --no-tags "https://github.com/${GITHUB_REPOSITORY}.git" "refs/tags/${TAG}"
commit_sha=$(git rev-parse 'FETCH_HEAD^{commit}')
for file in "${expected_files[@]}"; do
  gh attestation verify "$work_dir/$file" \
    --repo "$GITHUB_REPOSITORY" \
    --signer-workflow "$SIGNER_WORKFLOW" \
    --source-ref "refs/tags/${TAG}" \
    --source-digest "$commit_sha" >/dev/null
done

manifest_sha=$(sha256sum "$manifest" | cut -d' ' -f1)
record_value=$(jq -cn \
  --arg version "$VERSION" --arg tag "$TAG" --arg commitSha "$commit_sha" \
  --arg manifestSha256 "$manifest_sha" \
  '{schemaVersion:1,version:$version,tag:$tag,commitSha:$commitSha,manifestSha256:$manifestSha256}')

get_parameter() {
  local name=$1 output error_file=$2
  if output=$(aws ssm get-parameter --name "$name" --query 'Parameter.Value' --output text \
    2>"$error_file"); then
    printf '%s' "$output"
    return 0
  fi
  if grep -q 'ParameterNotFound' "$error_file"; then return 3; fi
  cat "$error_file" >&2
  return 1
}

record_error="$work_dir/record-error"
if existing_record=$(get_parameter "$RECORD" "$record_error"); then
  if [ "$existing_record" != "$record_value" ]; then
    echo "immutable release record $RECORD already exists with different evidence" >&2
    exit 1
  fi
else
  result=$?
  [ "$result" -eq 3 ] || exit "$result"
  aws ssm put-parameter --name "$RECORD" --type String --value "$record_value" \
    --description "Verified immutable Sprout CLI release evidence" >/dev/null
fi

pointer_error="$work_dir/pointer-error"
current_version=""
pointer_changed=1
if current_version=$(get_parameter "$POINTER" "$pointer_error"); then
  if [ "$current_version" = "$VERSION" ]; then
    pointer_changed=0
  else
    # A production pointer only moves forward. An emergency rollback is a separate, explicit
    # operation with its own evidence; retagging or quietly dispatching an older version is not it.
    python3 - "$current_version" "$VERSION" <<'PYTHON'
import re, sys

def parse(value):
    match = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?", value)
    if match is None:
        raise SystemExit(f"current CLI pointer is not semantic version: {value}")
    core = tuple(map(int, match.group(1, 2, 3)))
    pre = match.group(4)
    parts = None if pre is None else tuple((0, int(p)) if p.isdigit() else (1, p) for p in pre.split("."))
    return core, parts

current, candidate = map(parse, sys.argv[1:])
if candidate[0] < current[0]:
    raise SystemExit("CLI release promotion refuses a version downgrade")
if candidate[0] == current[0]:
    if current[1] is None or candidate[1] is not None and candidate[1] <= current[1]:
        raise SystemExit("CLI release promotion must move to a newer semantic version")
PYTHON
  fi
else
  result=$?
  [ "$result" -eq 3 ] || exit "$result"
fi

if [ "$pointer_changed" = 1 ]; then
  aws ssm put-parameter --name "$POINTER" --type String --value "$VERSION" --overwrite \
    --description "Verified Sprout CLI release exposed by the production download page" >/dev/null
fi

if [ "$MODE" = --record-only ]; then
  echo "recorded verified immutable CLI $VERSION; ECS rollout intentionally deferred"
  exit 0
fi

service_json=$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --output json)
task_arn=$(jq -r '.services[0].taskDefinition // empty' <<<"$service_json")
if [ -z "$task_arn" ]; then
  echo "ECS service $CLUSTER/$SERVICE has no task definition" >&2
  exit 1
fi
task_json=$(aws ecs describe-task-definition --task-definition "$task_arn" --output json)

wrong_ref=$(jq -r --arg arn "$POINTER_ARN" '
  [.taskDefinition.containerDefinitions[] | select(.name == "website") | .secrets[]? |
    select(.name == "SPROUT_CLI_RELEASE_VERSION" and .valueFrom != $arn)] | length
' <<<"$task_json")
if [ "$wrong_ref" != 0 ]; then
  echo "serving task has a conflicting SPROUT_CLI_RELEASE_VERSION source" >&2
  exit 1
fi

has_ref=$(jq -r --arg arn "$POINTER_ARN" '
  [.taskDefinition.containerDefinitions[] | select(.name == "website") | .secrets[]? |
    select(.name == "SPROUT_CLI_RELEASE_VERSION" and .valueFrom == $arn)] | length
' <<<"$task_json")
if [ "$has_ref" != 1 ]; then
  echo "serving task does not contain the exact SPROUT_CLI_RELEASE_VERSION SSM reference" >&2
  echo "apply the reviewed OpenTofu task contract and deploy it from that exact base revision" >&2
  exit 1
fi

if [ "$pointer_changed" = 1 ]; then
  # Deliberately omit --task-definition. IAM enforces that omission too: this authority can force
  # the serving image to reread SSM, but cannot deploy a different image or task contract.
  aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" \
    --force-new-deployment >/dev/null
  # The AWS waiter itself is bounded (40 attempts, 15 seconds apart); do not turn a failed rollout
  # into a workflow that waits forever.
  aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE"
fi

settled=$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --output json)
jq -e --arg task "$task_arn" '
  .services[0] as $service |
  $service.taskDefinition == $task and
  $service.runningCount == $service.desiredCount and
  ([ $service.deployments[] | select(
    .status == "PRIMARY" and .taskDefinition == $task and .rolloutState == "COMPLETED"
  ) ] | length) == 1
' <<<"$settled" >/dev/null || {
  echo "ECS became stable without the promoted task completing" >&2
  exit 1
}

if [ -n "${CLI_DOWNLOAD_URL:-}" ]; then
  for attempt in $(seq 1 12); do
    if page=$(curl --fail --silent --show-error "$CLI_DOWNLOAD_URL") &&
      grep -Fq "Version ${VERSION}" <<<"$page" &&
      grep -Fq "releases/download/${TAG}/" <<<"$page"; then
      echo "promoted immutable CLI $VERSION and verified $CLI_DOWNLOAD_URL"
      exit 0
    fi
    [ "$attempt" -eq 12 ] || sleep 10
  done
  echo "$CLI_DOWNLOAD_URL did not expose CLI $VERSION after ECS became stable" >&2
  exit 1
fi

echo "promoted immutable CLI $VERSION"
