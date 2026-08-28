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
version=0.1.0
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
    printf '{"tagName":"cli-v0.1.0","isDraft":false,"isPrerelease":false,"isImmutable":%s}\n' "${MUTABLE:-true}"
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
    if [ -f "$STATE/updated" ]; then
      secret=',"secrets":[{"name":"SPROUT_CLI_RELEASE_VERSION","valueFrom":"arn:aws:ssm:us-east-1:123:parameter/sproutos/application/SPROUT_CLI_RELEASE_VERSION"}]'
    else secret=''
    fi
    printf '{"taskDefinition":{"taskDefinitionArn":"arn:aws:ecs:us-east-1:123:task-definition/sproutos-web:7","family":"sproutos-web","taskRoleArn":"arn:task","executionRoleArn":"arn:execution","networkMode":"bridge","requiresCompatibilities":["EC2"],"cpu":"1024","memory":"768","containerDefinitions":[{"name":"website","image":"image:current"%s},{"name":"api","image":"image:current"}]}}\n' "$secret"
    ;;
  "ecs update-service") : >"$STATE/updated" ;;
  "ecs wait") ;;
  *) echo "unexpected aws call: $*" >&2; exit 98 ;;
esac
AWS

cat >"$TEST_DIR/bin/curl" <<'CURL'
#!/usr/bin/env bash
printf '<p>Version 0.1.0</p><a href="releases/download/cli-v0.1.0/sprout">download</a>\n'
CURL

chmod +x "$TEST_DIR/bin/gh" "$TEST_DIR/bin/git" "$TEST_DIR/bin/aws" "$TEST_DIR/bin/curl"
export PATH="$TEST_DIR/bin:$PATH"
export RELEASE_DIR="$TEST_DIR/release" STATE="$TEST_DIR/state" CAPTURE="$TEST_DIR/capture"
export CALLS="$TEST_DIR/calls" GITHUB_REPOSITORY=MySproutOS/SproutOS NAME_PREFIX=sproutos
export AWS_ACCOUNT_ID=123 AWS_REGION=us-east-1 CLI_DOWNLOAD_URL=https://sproutos.me/download

# The shell refuses to select a task definition; IAM must enforce the same boundary if the workflow
# is edited or compromised. Evidence records are append-only at IAM, not just by convention.
promotion_policy=$(sed -n '/resource "aws_iam_role_policy" "github_actions_cli_release_promotion"/,$p' \
  "$HERE/../tofu/oidc.tf")
grep -q '"ssm:Overwrite" = "false"' <<<"$promotion_policy"
grep -q '"ssm:Overwrite" = "true"' <<<"$promotion_policy"
grep -q '"ecs:task-definition" = "true"' <<<"$promotion_policy"
if grep -q 'ecs:RegisterTaskDefinition\|iam:PassRole' <<<"$promotion_policy"; then
  echo "CLI promotion role can deploy a task definition" >&2
  exit 1
fi

"$HERE/promote-cli-release.sh" "$version" --record-only

[ "$(cat "$TEST_DIR/state/SPROUT_CLI_RELEASE_VERSION")" = "$version" ]
jq -e '.version == "0.1.0" and .commitSha == "0123456789abcdef0123456789abcdef01234567"' \
  "$TEST_DIR/state/$version" >/dev/null
[ "$(grep -c '^attestation verify ' "$CALLS")" -eq 7 ]
if grep -q '^ecs ' "$CALLS"; then
  echo "record-only release touched ECS" >&2
  exit 1
fi

# Simulate the normal deploy role carrying the reviewed OpenTofu SSM reference into the serving
# image. A retry proves the public result without another pointer write, but still restarts ECS so
# it can recover from an earlier run that moved SSM and failed before task replacement.
: >"$TEST_DIR/state/updated"
: >"$CALLS"
"$HERE/promote-cli-release.sh" "$version"
if grep -q '^ssm put-parameter' "$CALLS"; then
  echo "idempotent release rewrote the pointer" >&2
  exit 1
fi
grep -q '^ecs update-service .*--force-new-deployment' "$CALLS"

# A later verified pointer change force-restarts the serving task without registering or selecting
# a task definition. That is the entire ECS authority the promotion role needs.
printf 0.0.9 >"$TEST_DIR/state/SPROUT_CLI_RELEASE_VERSION"
: >"$CALLS"
"$HERE/promote-cli-release.sh" "$version"
grep -q '^ecs update-service .*--force-new-deployment' "$CALLS"
if grep -q '^ecs register-task-definition\|^ecs update-service .*--task-definition' "$CALLS"; then
  echo "CLI promotion gained task-definition deployment authority" >&2
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
