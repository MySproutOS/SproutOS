#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
cleanup() {
  find "$TMP" -type f -delete
  rmdir "$TMP/bin" 2>/dev/null || true
  rmdir "$TMP" 2>/dev/null || true
}
trap cleanup EXIT
mkdir "$TMP/bin"

cat >"$TMP/bin/tofu" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
case "${*: -1}" in
  acme_worker_rollout_state)
    if [ -n "${ROLLOUT_STATE:-}" ]; then printf '%s\n' "$ROLLOUT_STATE"
    else echo '{"capacity_enabled":false,"handler_ownership_enabled":false,"fallback_iam_enabled":true}'
    fi
    ;;
  acme_worker_policy_arn) echo arn:aws:iam::a:policy/sproutos-acme-worker ;;
  ecs_web_task_definition_arn) echo arn:aws:ecs:r:a:task-definition/sproutos-web:base ;;
  application_policy_arn) echo arn:aws:iam::a:policy/sproutos-application ;;
  application_policy_document) printf '%s\n' "$REVIEWED_POLICY" ;;
  ignored.tfplan) printf '%s\n' "$PLAN_JSON" ;;
  *) exit 98 ;;
esac
STUB

cat >"$TMP/bin/aws" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
case "$1 $2" in
  'ec2 describe-launch-templates')
    latest=1
    [ "${LT_DRIFT:-}" != 1 ] || latest=2
    jq -nc --argjson latest "$latest" '{LaunchTemplates:[{
      LaunchTemplateId:"lt-012345",LaunchTemplateName:"sproutos-ecs-test",
      LatestVersionNumber:$latest,DefaultVersionNumber:1
    }]}'
    ;;
  'ecs describe-services')
    web='arn:aws:ecs:r:a:task-definition/sproutos-web:51'
    pending=${BAD_PENDING:-0}
    if [ "${ACME_PRESENT:-}" = 1 ]; then
      acme_service='[{"serviceName":"sproutos-acme-worker"}]'; failures='[]'
    else
      acme_service='[]'
      if [ "${EXTRA_FAILURE:-}" = 1 ]; then
        failures='[{"arn":"sproutos-acme-worker","reason":"MISSING"},{"arn":"other","reason":"MISSING"}]'
      else
        failures='[{"arn":"arn:aws:ecs:r:a:service/sproutos/sproutos-acme-worker","reason":"MISSING"}]'
      fi
    fi
    jq -nc --arg web "$web" --argjson pending "$pending" --argjson acme "$acme_service" \
      --argjson failures "$failures" '{services:([{
        serviceName:"sproutos-web",status:"ACTIVE",taskDefinition:$web,
        desiredCount:2,runningCount:2,pendingCount:$pending,
        deployments:[{status:"PRIMARY",taskDefinition:$web,desiredCount:2,runningCount:2,
          pendingCount:$pending,rolloutState:"COMPLETED"}]
      }] + $acme),failures:$failures}'
    ;;
  'ecs describe-task-definition')
    task=''
    while [ "$#" -gt 0 ]; do
      if [ "$1" = --task-definition ]; then task=$2; shift 2; else shift; fi
    done
    image=$IMAGE; ownership=0; role=arn:aws:iam::a:role/sproutos-task; secret=shared-secret
    if [[ "$task" == *:base ]]; then
      image=tofu:image
    else
      [ "${BAD_IMAGE:-}" != 1 ] || image=wrong:image
      [ "${BAD_ENV:-}" != 1 ] || ownership=1
      [ "${NO_ROLE:-}" != 1 ] || role=null
      [ "${BAD_SECRET:-}" != 1 ] || secret=wrong-secret
    fi
    if [[ "$task" == *:base ]] || [ "${OMIT_OWNERSHIP:-}" != 1 ]; then
      ownership_entry=$(jq -nc --arg ownership "$ownership" '[{name:"ACME_HANDLER_OWNERSHIP_ENABLED",value:$ownership}]')
    else ownership_entry='[]'
    fi
    jq -nc --arg image "$image" --arg secret "$secret" --argjson ownership "$ownership_entry" --argjson role "$(jq -nc --arg role "$role" 'if $role == "null" then null else $role end')" '{taskDefinition:{
      family:"sproutos-web",taskRoleArn:$role,containerDefinitions:[
        {name:"website",image:$image,environment:[]},
        {name:"api",image:$image,environment:[]},
        {name:"worker",image:$image,environment:([{name:"ACME_JOBS_ENABLED",value:"0"}] + $ownership),secrets:[{name:"SHARED",valueFrom:$secret}]}
      ]}}'
    ;;
  'ecs list-tasks')
    if [[ " $* " == *" --service-name sproutos-acme-worker "* ]]; then
      if [ "${ACME_TASK:-}" = 1 ]; then echo '{"taskArns":["arn:task/acme"]}'; else echo '{"taskArns":[]}'; fi
    else
      echo '{"taskArns":["arn:task/web0","arn:task/web1"]}'
    fi
    ;;
  'ecs describe-tasks')
    task=arn:aws:ecs:r:a:task-definition/sproutos-web:51
    [ "${BAD_TASK_REV:-}" != 1 ] || task=arn:wrong
    jq -nc --arg task "$task" '{failures:[],tasks:[range(0;2)|{taskDefinitionArn:$task,lastStatus:"RUNNING",desiredStatus:"RUNNING"}]}'
    ;;
  'iam list-attached-role-policies')
    if [ "${NO_FALLBACK:-}" = 1 ]; then echo '{"AttachedPolicies":[]}'
    else echo '{"AttachedPolicies":[{"PolicyArn":"arn:aws:iam::a:policy/sproutos-acme-worker"}]}'
    fi
    ;;
  'iam get-policy') echo '{"Policy":{"DefaultVersionId":"v3"}}' ;;
  'iam get-policy-version')
    if [ "${POLICY_DRIFT:-}" = 1 ]; then
      document='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"s3:*","Resource":"*"}]}'
    else document=$REVIEWED_POLICY
    fi
    jq -nc --argjson document "$document" '{PolicyVersion:{Document:$document}}'
    ;;
  *) echo "unexpected aws call: $*" >&2; exit 98 ;;
esac
STUB
chmod +x "$TMP/bin/tofu" "$TMP/bin/aws"

run_check() {
  local policy plan_json
  policy='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"route53:ChangeResourceRecordSets","Resource":"arn:aws:route53:::hostedzone/Z1"}]}'
  plan_json='{"resource_changes":[{"address":"aws_launch_template.ecs","change":{"before":{"id":"lt-012345","name":"sproutos-ecs-test","latest_version":1,"default_version":1}}}]}'
  PLAN_JSON="$plan_json" REVIEWED_POLICY="$policy" PATH="$TMP/bin:$PATH" NAME_PREFIX=sproutos \
    IMAGE="${TEST_IMAGE:-ghcr.io/mysproutos/sproutos-web:57a582dd03a1}" \
    "$ROOT/bin/verify-acme-worker-partial-a.sh" ignored.tfplan
}

run_check
OMIT_OWNERSHIP=1 run_check
OMIT_OWNERSHIP=1 TEST_IMAGE=ghcr.io/mysproutos/sproutos-web:new-merge-image run_check
for failure in ACME_PRESENT EXTRA_FAILURE BAD_PENDING BAD_IMAGE BAD_ENV BAD_SECRET BAD_TASK_REV ACME_TASK NO_FALLBACK NO_ROLE POLICY_DRIFT LT_DRIFT; do
  export "$failure=1"
  if run_check >"$TMP/$failure.out" 2>&1; then
    echo "partial-A verifier accepted $failure" >&2
    exit 1
  fi
  unset "$failure"
done

export ROLLOUT_STATE='{"capacity_enabled":true,"handler_ownership_enabled":false,"fallback_iam_enabled":true}'
if run_check >"$TMP/wrong-state.out" 2>&1; then
  echo "partial-A verifier accepted phase B state" >&2
  exit 1
fi

echo "partial-A verifier rejects unsafe gates, service shape, runtime tasks, and fallback IAM"
