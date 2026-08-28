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
    if [[ " $* " == *" --services sproutos-acme-worker "* ]]; then
      if [ "${ACME_PRESENT:-}" = 1 ]; then
        if [ -e "$ACME_UPDATED" ]; then
          task=$(cat "$ACME_UPDATED")
        else
          task="arn:aws:ecs:us-east-1:123:task-definition/sproutos-acme-worker:7"
        fi
        printf '{"services":[{"status":"ACTIVE","taskDefinition":"%s","desiredCount":1,"runningCount":1,"capacityProviderStrategy":[{"capacityProvider":"sproutos-ec2"}],"loadBalancers":[]}],"failures":[]}\n' "$task"
        exit 0
      fi
      printf '{"services":[],"failures":[{"arn":"sproutos-acme-worker","reason":"MISSING"}]}\n'
      exit 0
    fi
    if [ -e "$UPDATED" ]; then
      task=$(cat "$UPDATED")
      if [ "${AUTO_ROLLBACK:-}" = 1 ] && [ "$task" = "arn:aws:ecs:us-east-1:123:task-definition/sproutos-web:8" ]; then
        task="arn:aws:ecs:us-east-1:123:task-definition/sproutos-web:7"
      fi
      running=1
    else
      task="arn:aws:ecs:us-east-1:123:task-definition/sproutos-web:7"
      running=1
    fi
    printf '{"services":[{"status":"ACTIVE","taskDefinition":"%s","runningCount":%s,"capacityProviderStrategy":[{"capacityProvider":"sproutos-ec2"}],"loadBalancers":[{"targetGroupArn":"arn:web-green"},{"targetGroupArn":"arn:api-green"}]}]}\n' "$task" "$running"
    ;;
  "ecs describe-task-definition")
    task_reference=""
    while [ $# -gt 0 ]; do
      if [ "$1" = "--task-definition" ]; then task_reference=$2; break; fi
      shift
    done
    if [[ "$task_reference" == *"sproutos-acme-worker:"* ]]; then
      cat <<JSON
{"taskDefinition":{"taskDefinitionArn":"$task_reference","status":"ACTIVE","family":"sproutos-acme-worker","taskRoleArn":"arn:acme-task-role","executionRoleArn":"arn:execution-role","networkMode":"bridge","requiresCompatibilities":["EC2"],"cpu":"128","memory":"128","containerDefinitions":[{"name":"acme-worker","image":"old:tag","essential":true,"memoryReservation":128,"command":["node","/opt/sproutos/api/worker.js"],"environment":[{"name":"WORKER_PROFILE","value":"acme"}]}]}}
JSON
      exit 0
    elif [ "$task_reference" = "arn:aws:ecs:us-east-1:123:task-definition/sproutos-web:42" ]; then
      clickhouse_database=sproutos
    else
      clickhouse_database=observability
    fi
    cat <<JSON
{"taskDefinition":{"taskDefinitionArn":"$task_reference","status":"ACTIVE","family":"sproutos-web","taskRoleArn":"arn:task-role","executionRoleArn":"arn:execution-role","networkMode":"bridge","requiresCompatibilities":["EC2"],"cpu":"1024","memory":"768","containerDefinitions":[{"name":"website","image":"old:tag","essential":true,"memoryReservation":320,"portMappings":[{"containerPort":8080,"hostPort":8080}],"environment":[{"name":"PORT","value":"8080"}],"secrets":[],"logConfiguration":{"logDriver":"awslogs","options":{"awslogs-stream-prefix":"website"}}},{"name":"api","image":"old:tag","essential":true,"memoryReservation":320,"command":["node","/opt/sproutos/api/server.js"],"portMappings":[{"containerPort":3001,"hostPort":3001}],"environment":[{"name":"DATABASE_HOST","value":"db"},{"name":"CLICKHOUSE_URL","value":"https://clickhouse.example"},{"name":"CLICKHOUSE_DATABASE","value":"$clickhouse_database"}],"secrets":[{"name":"DATABASE_SECRET","valueFrom":"arn:secret"}],"logConfiguration":{"logDriver":"awslogs","options":{"awslogs-stream-prefix":"api"}}},{"name":"worker","image":"old:tag","essential":true,"memoryReservation":128,"command":["node","/opt/sproutos/api/worker.js"]}]}}
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
    elif [ "$count" = 2 ]; then
      printf 'arn:aws:ecs:us-east-1:123:task-definition/sproutos-web-migrate:3\n'
    else
      printf 'arn:aws:ecs:us-east-1:123:task-definition/sproutos-acme-worker:8\n'
    fi
    ;;
  "ecs run-task")
    printf '{"tasks":[{"taskArn":"arn:aws:ecs:us-east-1:123:task/cluster/migrate"}],"failures":[]}\n'
    ;;
  "ecs wait")
    if [[ "$*" == *"services-stable"* ]]; then
      count=1
      [ -e "$WAIT_COUNT" ] && count=$(( $(cat "$WAIT_COUNT") + 1 ))
      printf '%s' "$count" > "$WAIT_COUNT"
      if [ "${FAIL_SERVICE_WAIT:-}" = 1 ] && [ "$count" = 1 ]; then exit 255; fi
    fi
    ;;
  "ecs describe-tasks")
    if [ "${FAIL_MIGRATION:-}" = 1 ]; then exit_code=1; else exit_code=0; fi
    printf '{"tasks":[{"stopCode":"EssentialContainerExited","stoppedReason":"done","containers":[{"name":"migrate","exitCode":%s}]}]}\n' "$exit_code"
    ;;
  "ecs update-service")
    is_acme=""
    [[ " $* " == *" --service sproutos-acme-worker "* ]] && is_acme=1
    task_definition=""
    while [ $# -gt 0 ]; do
      if [ "$1" = "--task-definition" ]; then task_definition=$2; break; fi
      shift
    done
    if [ -n "$is_acme" ]; then
      printf '%s' "$task_definition" > "$ACME_UPDATED"
    else
      printf '%s' "$task_definition" > "$UPDATED"
    fi
    ;;
  "elbv2 describe-target-health")
    printf '%s\n' "${TARGET_HEALTHY:-1}"
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
export WAIT_COUNT="$TEST_DIR/wait-count"
export UPDATED="$TEST_DIR/updated"
export ACME_UPDATED="$TEST_DIR/acme-updated"
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
grep -q 'ecs update-service .*--deployment-configuration maximumPercent=200,minimumHealthyPercent=100,deploymentCircuitBreaker={enable=true,rollback=true}' "$STUB_CALLS"
if grep -q 'elbv2 modify-rule' "$STUB_CALLS"; then
  echo "an already-green ECS cutover must not rewrite listener rules" >&2
  exit 1
fi

# OpenTofu registers infrastructure-only task contract changes, but the service intentionally
# ignores task-definition drift. An exact override must seed both the migration and service
# revisions with that corrected contract before the service changes.
unlink "$UPDATED"
unlink "$REGISTER_COUNT"
unlink "$WAIT_COUNT"
: > "$STUB_CALLS"
find "$CAPTURE" -type f -exec unlink {} \;
ECS_BASE_TASK_DEFINITION=arn:aws:ecs:us-east-1:123:task-definition/sproutos-web:42 \
  "$HERE/deploy-ecs-web.sh"
jq -e '
  .containerDefinitions[]
  | select(.name == "api")
  | .environment[]
  | select(.name == "CLICKHOUSE_DATABASE" and .value == "sproutos")
' "$CAPTURE/task-1.json" >/dev/null
grep -q 'ecs describe-task-definition --task-definition arn:aws:ecs:us-east-1:123:task-definition/sproutos-web:42' "$STUB_CALLS"
grep -q 'ecs run-task .*sproutos-web-migrate:3' "$STUB_CALLS"
grep -q 'ecs update-service .*sproutos-web:8 .*--desired-count 1' "$STUB_CALLS"

# A failed migration is a hard gate: it must not mutate the service.
unlink "$UPDATED"
unlink "$REGISTER_COUNT"
unlink "$WAIT_COUNT"
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

# The AWS service waiter is bounded. If the replacement does not settle in that window, restore
# the exact task revision that was healthy before the release and wait (bounded again) for it.
unlink "$REGISTER_COUNT"
: > "$STUB_CALLS"
find "$CAPTURE" -type f -exec unlink {} \;
if FAIL_SERVICE_WAIT=1 "$HERE/deploy-ecs-web.sh" >"$TEST_DIR/wait-failure.out" 2>&1; then
  echo "a timed-out ECS deployment reported success" >&2
  exit 1
fi
grep -q 'release did not stabilize within the bounded ECS waiter' "$TEST_DIR/wait-failure.out"
grep -q 'rollback restored arn:aws:ecs:us-east-1:123:task-definition/sproutos-web:7' "$TEST_DIR/wait-failure.out"
grep -q 'ecs update-service .*sproutos-web:8 .*--deployment-configuration maximumPercent=200,minimumHealthyPercent=100' "$STUB_CALLS"
grep -q 'ecs update-service .*sproutos-web:7 .*--deployment-configuration maximumPercent=200,minimumHealthyPercent=100' "$STUB_CALLS"

# Target-group health is an effect assertion after the ECS waiter. A failed assertion also restores
# the old revision instead of leaving a release the deploy script itself judged unsafe.
unlink "$UPDATED"
unlink "$REGISTER_COUNT"
unlink "$WAIT_COUNT"
: > "$STUB_CALLS"
find "$CAPTURE" -type f -exec unlink {} \;
if TARGET_HEALTHY=0 "$HERE/deploy-ecs-web.sh" >"$TEST_DIR/target-failure.out" 2>&1; then
  echo "an unhealthy target group reported success" >&2
  exit 1
fi
grep -q 'target group arn:web-green has 0 healthy target(s), wanted 1' "$TEST_DIR/target-failure.out"
grep -q 'rollback restored arn:aws:ecs:us-east-1:123:task-definition/sproutos-web:7' "$TEST_DIR/target-failure.out"

# The deployment circuit breaker may finish its own rollback before the waiter returns. That is a
# failed release, not a stable new one, and it must not trigger a redundant second rollback deploy.
unlink "$UPDATED"
unlink "$REGISTER_COUNT"
unlink "$WAIT_COUNT"
: > "$STUB_CALLS"
find "$CAPTURE" -type f -exec unlink {} \;
if AUTO_ROLLBACK=1 "$HERE/deploy-ecs-web.sh" >"$TEST_DIR/auto-rollback.out" 2>&1; then
  echo "an automatic circuit-breaker rollback reported a successful release" >&2
  exit 1
fi
grep -q 'ECS waiter returned but the requested release did not settle' "$TEST_DIR/auto-rollback.out"
[ "$(grep -c 'ecs update-service' "$STUB_CALLS")" = 1 ]

# Once OpenTofu provisions the dedicated service, the same release updates its isolated task role
# before changing the public website/API service.
unlink "$REGISTER_COUNT"
unlink "$WAIT_COUNT"
: > "$STUB_CALLS"
find "$CAPTURE" -type f -exec unlink {} \;
ACME_PRESENT=1 "$HERE/deploy-ecs-web.sh"
jq -e '
  .family == "sproutos-acme-worker" and
  .taskRoleArn == "arn:acme-task-role" and
  (.containerDefinitions | length) == 1 and
  .containerDefinitions[0].name == "acme-worker" and
  .containerDefinitions[0].image == "ghcr.io/mysproutos/sproutos-web:0123456789ab"
' "$CAPTURE/task-3.json" >/dev/null
grep -q 'ecs update-service .*--service sproutos-acme-worker .*sproutos-acme-worker:8' "$STUB_CALLS"
grep -q 'ecs update-service .*--service sproutos-acme-worker .*--deployment-configuration maximumPercent=200,minimumHealthyPercent=100' "$STUB_CALLS"

echo "deploy-ecs-web tests passed"
