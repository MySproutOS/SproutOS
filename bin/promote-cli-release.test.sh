#!/usr/bin/env bash
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
TEST_DIR=$(mktemp -d)
cleanup() {
  find "$TEST_DIR" -type f -exec unlink {} \; 2>/dev/null || true
  find "$TEST_DIR" -depth -type d -exec rmdir {} + 2>/dev/null || true
}
trap cleanup EXIT

mkdir -p "$TEST_DIR/bin" "$TEST_DIR/release" "$TEST_DIR/state" "$TEST_DIR/capture"
version=0.1.1
tag="cli-v${version}"
assets=(
  "sprout-v${version}-aarch64-apple-darwin.tar.gz"
  "sprout-v${version}-x86_64-apple-darwin.tar.gz"
  "sprout-v${version}-aarch64-unknown-linux-gnu.tar.gz"
  "sprout-v${version}-x86_64-unknown-linux-gnu.tar.gz"
  "sprout-v${version}-x86_64-pc-windows-msvc.zip"
)

for asset in "${assets[@]}"; do printf 'native %s\n' "$asset" >"$TEST_DIR/release/$asset"; done
(cd "$TEST_DIR/release" && sha256sum "${assets[@]}" >SHA256SUMS)

entries='[]'
for asset in "${assets[@]}"; do
  target=${asset#"sprout-v${version}-"}; target=${target%.tar.gz}; target=${target%.zip}
  case "$target" in
    aarch64-apple-darwin) os=macos; arch=arm64 ;;
    x86_64-apple-darwin) os=macos; arch=x86_64 ;;
    aarch64-unknown-linux-gnu) os=linux; arch=arm64 ;;
    x86_64-unknown-linux-gnu) os=linux; arch=x86_64 ;;
    x86_64-pc-windows-msvc) os=windows; arch=x86_64 ;;
  esac
  sha=$(sha256sum "$TEST_DIR/release/$asset" | cut -d' ' -f1)
  size=$(wc -c <"$TEST_DIR/release/$asset" | tr -d '[:space:]')
  url="https://github.com/MySproutOS/SproutOS/releases/download/${tag}/${asset}"
  entries=$(jq -c --arg target "$target" --arg os "$os" --arg arch "$arch" --arg url "$url" \
    --arg sha "$sha" --argjson size "$size" \
    '. + [{target:$target,os:$os,arch:$arch,url:$url,sha256:$sha,sizeBytes:$size}]' <<<"$entries")
done
jq -n --arg version "$version" --arg tag "$tag" --argjson assets "$entries" \
  '{schemaVersion:1,version:$version,tag:$tag,assets:$assets}' \
  >"$TEST_DIR/release/sprout-v${version}-manifest.json"

cat >"$TEST_DIR/bin/gh" <<'GH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$CALLS"
case "$1 $2" in
  "release view")
    printf '{"tagName":"cli-v0.1.1","isDraft":false,"isPrerelease":false,"isImmutable":%s}\n' "${MUTABLE:-true}"
    ;;
  "release download")
    destination=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = --dir ]; then destination=$2; break; fi
      shift
    done
    cp "$RELEASE_DIR"/* "$destination/"
    ;;
  "attestation verify") ;;
  *) echo "unexpected gh call: $*" >&2; exit 98 ;;
esac
GH

cat >"$TEST_DIR/bin/git" <<'GIT'
#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  fetch) ;;
  rev-parse) printf '%s\n' 0123456789abcdef0123456789abcdef01234567 ;;
  *) exec /usr/bin/git "$@" ;;
esac
GIT

cat >"$TEST_DIR/bin/aws" <<'AWS'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$CALLS"
case "$1 $2" in
  "ssm get-parameter")
    name=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = --name ]; then name=$2; break; fi
      shift
    done
    leaf=${name##*/}
    if [ -f "$STATE/$leaf" ]; then cat "$STATE/$leaf"; else echo ParameterNotFound >&2; exit 254; fi
    ;;
  "ssm put-parameter")
    name=""; value=""
    while [ "$#" -gt 0 ]; do
      case "$1" in --name) name=$2; shift 2 ;; --value) value=$2; shift 2 ;; *) shift ;; esac
    done
    printf '%s' "$value" >"$STATE/${name##*/}"
    ;;
  "ecs describe-services")
    if [ -f "$STATE/updated" ]; then task=8; else task=7; fi
    printf '{"services":[{"taskDefinition":"arn:aws:ecs:us-east-1:123:task-definition/sproutos-web:%s","desiredCount":1,"runningCount":1,"deployments":[{"status":"PRIMARY","taskDefinition":"arn:aws:ecs:us-east-1:123:task-definition/sproutos-web:%s","rolloutState":"COMPLETED"}]}]}\n' "$task" "$task"
    ;;
  "ecs describe-task-definition")
    if [ -f "$STATE/updated" ] || [[ "$*" == *sproutos-web:8* ]]; then
      secret=',"secrets":[{"name":"SPROUT_CLI_RELEASE_VERSION","valueFrom":"arn:aws:ssm:us-east-1:123:parameter/sproutos/application/SPROUT_CLI_RELEASE_VERSION"}]'
      revision=8
    else secret=''; revision=7
    fi
    printf '{"taskDefinition":{"taskDefinitionArn":"arn:aws:ecs:us-east-1:123:task-definition/sproutos-web:%s","family":"sproutos-web","taskRoleArn":"arn:task","executionRoleArn":"arn:execution","networkMode":"bridge","requiresCompatibilities":["EC2"],"cpu":"1024","memory":"768","containerDefinitions":[{"name":"website","image":"image:current"%s},{"name":"api","image":"image:current"}]}}\n' "$revision" "$secret"
    ;;
  "ecs update-service") : >"$STATE/updated" ;;
  "ecs wait") ;;
  *) echo "unexpected aws call: $*" >&2; exit 98 ;;
esac
AWS

cat >"$TEST_DIR/bin/curl" <<'CURL'
#!/usr/bin/env bash
printf '<p>Version 0.1.1</p><a href="releases/download/cli-v0.1.1/sprout">download</a>\n'
CURL

chmod +x "$TEST_DIR/bin/gh" "$TEST_DIR/bin/git" "$TEST_DIR/bin/aws" "$TEST_DIR/bin/curl"
export PATH="$TEST_DIR/bin:$PATH"
export RELEASE_DIR="$TEST_DIR/release" STATE="$TEST_DIR/state" CAPTURE="$TEST_DIR/capture"
export CALLS="$TEST_DIR/calls" GITHUB_REPOSITORY=MySproutOS/SproutOS NAME_PREFIX=sproutos
export AWS_ACCOUNT_ID=123 AWS_REGION=us-east-1 CLI_DOWNLOAD_URL=https://sproutos.me/download

# Workflow-dispatch input must cross into the shell through the environment. Interpolating it into
# `run` source would let a crafted version alter the shell program before this script validates it.
manual_workflow=$(<"$HERE/../.github/workflows/cli-promote.yml")
grep -q '^    environment: cli-release-production$' <<<"$manual_workflow"
if grep -q '^    environment: production$' <<<"$manual_workflow"; then
  echo "CLI promotion shares the automatic deployment environment" >&2
  exit 1
fi
# shellcheck disable=SC2016
test "$(grep -Fc 'run: bin/promote-cli-release.sh "$VERSION"' <<<"$manual_workflow")" -eq 2
# shellcheck disable=SC2016
if grep -Fq 'run: bin/promote-cli-release.sh "${{ inputs.version }}"' <<<"$manual_workflow"; then
  echo "workflow-dispatch version is interpolated directly into shell source" >&2
  exit 1
fi

# The shell refuses to select a task definition; IAM must enforce the same boundary if the workflow
# is edited or compromised. Evidence records are append-only at IAM, not just by convention.
promotion_policy=$(sed -n '/resource "aws_iam_role_policy" "github_actions_cli_release_promotion"/,$p' \
  "$HERE/../tofu/oidc.tf")
promotion_role=$(sed -n '/resource "aws_iam_role" "github_actions_cli_release_promotion"/,/resource "aws_iam_role_policy" "github_actions_cli_release_promotion"/p' \
  "$HERE/../tofu/oidc.tf")
deploy_role=$(sed -n '/resource "aws_iam_role" "deploy"/,/resource "aws_iam_role_policy" "deploy"/p' \
  "$HERE/../tofu/oidc.tf")
# Both OIDC roles preserve the repository-name and exact repository-ID subjects. The promotion role
# must not accept the shared environment merely because the deploy role still needs it.
test "$(grep -Fc 'repo:${var.github_repo}:environment:cli-release-production' <<<"$promotion_role")" -eq 1
test "$(grep -Fc 'repo:${var.github_repo_ids}:environment:cli-release-production' <<<"$promotion_role")" -eq 1
test "$(grep -Fc 'repo:${var.github_repo}:environment:cli-release-production' <<<"$deploy_role")" -eq 1
test "$(grep -Fc 'repo:${var.github_repo_ids}:environment:cli-release-production' <<<"$deploy_role")" -eq 1
test "$(grep -Fc '"repo:${' <<<"$promotion_role")" -eq 2
if grep -q 'environment:production' <<<"$promotion_role"; then
  echo "CLI promotion role trusts the shared production environment" >&2
  exit 1
fi
if grep -q 'refs/tags/cli-v' <<<"$promotion_role"; then
  echo "CLI promotion role trusts tag refs outside the dedicated promotion environment" >&2
  exit 1
fi
grep -q '"ssm:Overwrite" = "false"' <<<"$promotion_policy"
grep -q '"ssm:Overwrite" = "true"' <<<"$promotion_policy"
if grep -q 'ecs:UpdateService\|ecs:RegisterTaskDefinition\|iam:PassRole' <<<"$promotion_policy"; then
  echo "CLI promotion role can mutate ECS" >&2
  exit 1
fi

# Canonical SemVer accepts prerelease plus build metadata and rejects leading-zero core versions.
if "$HERE/promote-cli-release.sh" 01.2.3 >"$TEST_DIR/invalid-semver.out" 2>&1; then
  echo "invalid semantic version was accepted" >&2
  exit 1
fi
grep -q '^usage:' "$TEST_DIR/invalid-semver.out"
: >"$CALLS"
if "$HERE/promote-cli-release.sh" 1.2.3-alpha.1+build.5 >"$TEST_DIR/valid-semver.out" 2>&1; then
  echo "unexpected fixture release matched another version" >&2
  exit 1
fi
grep -q '^release view cli-v1.2.3-alpha.1+build.5 ' "$CALLS"
if grep -q '^usage:' "$TEST_DIR/valid-semver.out"; then
  echo "valid semantic version was rejected by argument validation" >&2
  exit 1
fi

# An attested manifest still has to map each native target to its canonical public os/arch label.
manifest="$TEST_DIR/release/sprout-v${version}-manifest.json"
cp "$manifest" "$TEST_DIR/capture/manifest.json"
jq '(.assets[] | select(.target == "aarch64-apple-darwin") | .os) = "linux"' \
  "$manifest" >"$TEST_DIR/capture/wrong-platform.json"
cp "$TEST_DIR/capture/wrong-platform.json" "$manifest"
if "$HERE/promote-cli-release.sh" "$version" >"$TEST_DIR/wrong-platform.out" 2>&1; then
  echo "manifest with wrong platform mapping was accepted" >&2
  exit 1
fi
grep -q 'wrong version, tag, schema, or platform set' "$TEST_DIR/wrong-platform.out"
cp "$TEST_DIR/capture/manifest.json" "$manifest"

# Evidence may be recorded independently, but a pointer cannot move until an exact task contract
# with the SSM reference is already reviewed and available for deployment.
if "$HERE/promote-cli-release.sh" "$version" --record-only >"$TEST_DIR/missing-contract.out" 2>&1; then
  echo "pointer moved without a deployable task contract" >&2
  exit 1
fi
grep -q 'task contract does not contain the exact' "$TEST_DIR/missing-contract.out"
test ! -f "$TEST_DIR/state/SPROUT_CLI_RELEASE_VERSION"

: >"$CALLS"
ECS_BASE_TASK_DEFINITION=arn:aws:ecs:us-east-1:123:task-definition/sproutos-web:8 \
  "$HERE/promote-cli-release.sh" "$version" --record-only

[ "$(cat "$TEST_DIR/state/SPROUT_CLI_RELEASE_VERSION")" = "$version" ]
jq -e '.version == "0.1.1" and .commitSha == "0123456789abcdef0123456789abcdef01234567"' \
  "$TEST_DIR/state/$version" >/dev/null
[ "$(grep -c '^attestation verify ' "$CALLS")" -eq 7 ]
if grep -q '^ecs update-service\|^ecs wait\|^ecs register-task-definition' "$CALLS"; then
  echo "record-only release mutated ECS" >&2
  exit 1
fi

# Simulate the normal deploy role carrying the reviewed OpenTofu SSM reference into the serving
# image. A retry proves the public result without another pointer write or any ECS mutation.
: >"$TEST_DIR/state/updated"
: >"$CALLS"
"$HERE/promote-cli-release.sh" "$version"
if grep -q '^ssm put-parameter' "$CALLS"; then
  echo "idempotent release rewrote the pointer" >&2
  exit 1
fi
if grep -q '^ecs update-service\|^ecs wait\|^ecs register-task-definition' "$CALLS"; then
  echo "idempotent verification mutated ECS" >&2
  exit 1
fi

# A later verified pointer change remains read-only in ECS. The normal deployment role owns the
# rollout that reloads the pointer.
printf 0.0.9 >"$TEST_DIR/state/SPROUT_CLI_RELEASE_VERSION"
: >"$CALLS"
"$HERE/promote-cli-release.sh" "$version"
if grep -q '^ecs update-service\|^ecs wait\|^ecs register-task-definition' "$CALLS"; then
  echo "CLI promotion mutated ECS" >&2
  exit 1
fi

# Even otherwise valid artifacts cannot become configuration while GitHub reports the release as
# mutable. The check occurs before an AWS read or write.
: >"$CALLS"
if MUTABLE=false "$HERE/promote-cli-release.sh" "$version" >"$TEST_DIR/mutable.out" 2>&1; then
  echo "mutable release was promoted" >&2
  exit 1
fi
grep -q 'absent, mutable, a draft, or a prerelease' "$TEST_DIR/mutable.out"
if grep -q '^ssm\|^ecs' "$CALLS"; then
  echo "mutable release reached AWS" >&2
  exit 1
fi

echo "CLI release promotion tests passed"
