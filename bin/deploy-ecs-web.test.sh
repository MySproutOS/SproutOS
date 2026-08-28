#!/usr/bin/env bash
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
TEST_DIR=$(mktemp -d)
cleanup() {
  find "$TEST_DIR" -type f -exec unlink {} \; 2>/dev/null || true
  find "$TEST_DIR" -depth -type d -exec rmdir {} + 2>/dev/null || true
}
trap cleanup EXIT

mkdir -p "$TEST_DIR/bin" "$TEST_DIR/capture"

cat > "$TEST_DIR/bin/aws" <<'AWS'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$STUB_CALLS"

case "$1 $2" in
  "ecs describe-services")
    if [ -e "$UPDATED" ]; then
      task="arn:aws:ecs:us-east-1:123:task-definition/sproutos-web:8"
      running=1
    else
      task="arn:aws:ecs:us-east-1:123:task-definition/sproutos-web:7"
      running=0
    fi
    printf '{"services":[{"status":"ACTIVE","taskDefinition":"%s","runningCount":%s,"capacityProviderStrategy":[{"capacityProvider":"sproutos-ec2"}],"loadBalancers":[{"targetGroupArn":"arn:web-green"},{"targetGroupArn":"arn:api-green"}]}]}\n' "$task" "$running"
    ;;
  "ecs describe-task-definition")
    cat <<'JSON'
{"taskDefinition":{"family":"sproutos-web","taskRoleArn":"arn:task-role","executionRoleArn":"arn:execution-role","networkMode":"bridge","requiresCompatibilities":["EC2"],"cpu":"1024","memory":"768","containerDefinitions":[{"name":"website","image":"old:tag","essential":true,"memoryReservation":320,"portMappings":[{"containerPort":8080,"hostPort":8080}],"environment":[{"name":"PORT","value":"8080"}],"secrets":[],"logConfiguration":{"logDriver":"awslogs","options":{"awslogs-stream-prefix":"website"}}},{"name":"api","image":"old:tag","essential":true,"memoryReservation":320,"command":["node","/opt/sproutos/api/server.js"],"portMappings":[{"containerPort":3001,"hostPort":3001}],"environment":[{"name":"DATABASE_HOST","value":"db"},{"name":"CLICKHOUSE_URL","value":"https://clickhouse.example"}],"secrets":[{"name":"DATABASE_SECRET","valueFrom":"arn:secret"}],"logConfiguration":{"logDriver":"awslogs","options":{"awslogs-stream-prefix":"api"}}},{"name":"worker","image":"old:tag","essential":true,"memoryReservation":128,"command":["node","/opt/sproutos/api/worker.js"]}]}}
JSON
    ;;
  "ecs register-task-definition")
    input=""
    while [ $# -gt 0 ]; do
      if [ "$1" = "--cli-input-json" ]; then input=${2#file://}; break; fi
      shift
    done
    count=1
    [ -e "$REGISTER_COUNT" ] && count=$(( $(cat "$REGISTER_COUNT") + 1 ))
    printf '%s' "$count" > "$REGISTER_COUNT"
    cp "$input" "$CAPTURE/task-$count.json"
    if [ "$count" = 1 ]; then
      printf 'arn:aws:ecs:us-east-1:123:task-definition/sproutos-web:8\n'
    else
      printf 'arn:aws:ecs:us-east-1:123:task-definition/sproutos-web-migrate:3\n'
    fi
    ;;
  "ecs run-task")
    printf '{"tasks":[{"taskArn":"arn:aws:ecs:us-east-1:123:task/cluster/migrate"}],"failures":[]}\n'
    ;;
  "ecs wait") ;;
  "ecs describe-tasks")
    if [ "${FAIL_MIGRATION:-}" = 1 ]; then exit_code=1; else exit_code=0; fi
    printf '{"tasks":[{"stopCode":"EssentialContainerExited","stoppedReason":"done","containers":[{"name":"migrate","exitCode":%s}]}]}\n' "$exit_code"
    ;;
  "ecs update-service")
    : > "$UPDATED"
    ;;
  "elbv2 describe-target-health")
    printf '1\n'
    ;;
  "elbv2 describe-target-groups")
    name=""
    while [ $# -gt 0 ]; do
      if [ "$1" = "--names" ]; then name=$2; break; fi
      shift
    done
    printf 'arn:%s\n' "$name"
    ;;
  "elbv2 describe-rules")
    # The permanent ECS destination is already live, so --to green is an idempotent no-op.
    printf 'arn:sproutos-web-green\n'
    ;;
  *)
    echo "unexpected aws call: $*" >&2
    exit 98
    ;;
esac
AWS
chmod +x "$TEST_DIR/bin/aws"

export PATH="$TEST_DIR/bin:$PATH"
export STUB_CALLS="$TEST_DIR/calls"
export REGISTER_COUNT="$TEST_DIR/register-count"
export UPDATED="$TEST_DIR/updated"
export CAPTURE="$TEST_DIR/capture"
export NAME_PREFIX=sproutos
export IMAGE=ghcr.io/mysproutos/sproutos-web:0123456789ab
export LISTENER_ARN=arn:listener
export WEBSITE_RULE_ARN=arn:website-rule
export API_RULE_ARN=arn:api-rule

"$HERE/deploy-ecs-web.sh" --cutover

jq -e '
  .family == "sproutos-web" and
  ([.containerDefinitions[].image] | unique == ["ghcr.io/mysproutos/sproutos-web:0123456789ab"])
' "$CAPTURE/task-1.json" >/dev/null
jq -e '
  .family == "sproutos-web-migrate" and
  (.containerDefinitions | length) == 1 and
  .containerDefinitions[0].name == "migrate" and
  (.containerDefinitions[0].portMappings == null) and
  (.containerDefinitions[0].secrets[] | select(.name == "DATABASE_SECRET")) and
  (.containerDefinitions[0].command[2] | contains("migrate.mjs") and contains("seed.mjs") and contains("clickhouse.mjs"))
' "$CAPTURE/task-2.json" >/dev/null
grep -q 'ecs run-task .*sproutos-web-migrate:3' "$STUB_CALLS"
grep -q 'ecs update-service .*sproutos-web:8 .*--desired-count 1' "$STUB_CALLS"
if grep -q 'elbv2 modify-rule' "$STUB_CALLS"; then
  echo "an already-green ECS cutover must not rewrite listener rules" >&2
  exit 1
fi

# A failed migration is a hard gate: it must not mutate the service.
unlink "$UPDATED"
unlink "$REGISTER_COUNT"
: > "$STUB_CALLS"
find "$CAPTURE" -type f -exec unlink {} \;
if FAIL_MIGRATION=1 "$HERE/deploy-ecs-web.sh" >"$TEST_DIR/failure.out" 2>&1; then
  echo "a failed migration reported success" >&2
  exit 1
fi
if grep -q 'ecs update-service' "$STUB_CALLS"; then
  echo "the service was updated after a failed migration" >&2
  exit 1
fi
grep -q 'migration failed before the service was changed' "$TEST_DIR/failure.out"

echo "deploy-ecs-web tests passed"
