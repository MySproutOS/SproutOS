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
  acme_worker_rollout_state) printf '%s\n' "$ROLLOUT_STATE" ;;
  ecs_web_task_definition_arn) echo 'arn:aws:ecs:r:a:task-definition/sproutos-web:base' ;;
  ecs_acme_worker_task_definition_arn) echo 'arn:aws:ecs:r:a:task-definition/sproutos-acme-worker:base' ;;
  acme_worker_policy_arn) echo 'arn:aws:iam::a:policy/sproutos-acme-worker' ;;
  application_policy_arn) echo 'arn:aws:iam::a:policy/sproutos-application' ;;
  application_policy_document) printf '%s\n' "$REVIEWED_POLICY" ;;
  *) exit 98 ;;
esac
STUB

cat >"$TMP/bin/aws" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
case "$1 $2" in
  'ecs describe-services')
    web='arn:aws:ecs:r:a:task-definition/sproutos-web:51'
    acme='arn:aws:ecs:r:a:task-definition/sproutos-acme-worker:9'
    pending=${BAD_PENDING:-0}
    rollout=${BAD_ROLLOUT:-COMPLETED}
    if [ "${MISSING_ACME_SERVICE:-}" = 1 ]; then
      jq -nc --arg web "$web" --arg rollout "$rollout" --argjson pending "$pending" '{
        services: [
          {serviceName:"sproutos-web",status:"ACTIVE",taskDefinition:$web,desiredCount:2,runningCount:2,pendingCount:$pending,
           deployments:[{status:"PRIMARY",taskDefinition:$web,desiredCount:2,runningCount:2,pendingCount:$pending,rolloutState:$rollout}]}
        ], failures:[{arn:"sproutos-acme-worker",reason:"MISSING"}]}'
      exit
    fi
    jq -nc --arg web "$web" --arg acme "$acme" --arg rollout "$rollout" \
      --argjson pending "$pending" --argjson acmeCount "$ACME_COUNT" '{
      services: [
        {serviceName:"sproutos-web",status:"ACTIVE",taskDefinition:$web,desiredCount:2,runningCount:2,pendingCount:$pending,
         deployments:[{status:"PRIMARY",taskDefinition:$web,desiredCount:2,runningCount:2,pendingCount:$pending,rolloutState:$rollout}]},
        {serviceName:"sproutos-acme-worker",status:"ACTIVE",taskDefinition:$acme,desiredCount:$acmeCount,runningCount:$acmeCount,pendingCount:0,
         deployments:[{status:"PRIMARY",taskDefinition:$acme,desiredCount:$acmeCount,runningCount:$acmeCount,pendingCount:0,rolloutState:$rollout}]}
      ], failures:[]}'
    ;;
  'ecs describe-task-definition')
    task=''; query=''
    while [ "$#" -gt 0 ]; do
      case "$1" in --task-definition) task=$2; shift 2 ;; --query) query=$2; shift 2 ;; *) shift ;; esac
    done
    if [ -n "$query" ]; then echo 'arn:aws:iam::a:role/sproutos-task'; exit; fi
    if [[ "$task" == *acme-worker* ]]; then
      family=sproutos-acme-worker; container=acme-worker; role=arn:aws:iam::a:role/sproutos-acme-task
      environment='[{"name":"WORKER_PROFILE","value":"acme"}]'
    else
      family=sproutos-web; container=worker; role=arn:aws:iam::a:role/sproutos-task
      environment=$(jq -nc --arg capacity "$CAPACITY_ENV" --arg ownership "$OWNERSHIP_ENV" '[
        {name:"ACME_JOBS_ENABLED",value:$capacity},
        {name:"ACME_HANDLER_OWNERSHIP_ENABLED",value:$ownership}
      ]')
    fi
    image=$IMAGE
    [[ "$task" == *:base ]] && image=tofu:image
    [ "${BAD_IMAGE:-}" = 1 ] && [[ "$task" != *:base ]] && image=wrong:image
    [ "${BAD_ROLE:-}" = 1 ] && [[ "$task" != *:base ]] && role=arn:aws:iam::a:role/wrong
    [ "${BAD_ENV:-}" = 1 ] && [ "$container" = worker ] && environment='[]'
    if [ "$family" = sproutos-web ]; then
      api_secrets='[]'
      if [ "${BASE_CONTRACT_DRIFT:-}" = 1 ] && [[ "$task" == *:base ]]; then
        api_secrets='[{"name":"APK_SIGNER_TOKEN","valueFrom":"arn:runtime"},{"name":"APK_SIGNER_OPERATOR_TOKEN","valueFrom":"arn:operator"}]'
      fi
      containers=$(jq -nc --arg image "$image" --argjson environment "$environment" \
        --argjson api_secrets "$api_secrets" '[
          {name:"worker",image:$image,environment:$environment},
          {name:"api",image:$image,secrets:$api_secrets}
        ]')
    else
      containers=$(jq -nc --arg image "$image" --arg container "$container" \
        --argjson environment "$environment" '[{name:$container,image:$image,environment:$environment}]')
    fi
    jq -nc --arg arn "$task" --arg family "$family" --arg role "$role" \
      --argjson containers "$containers" '{taskDefinition:{
        taskDefinitionArn:$arn,family:$family,taskRoleArn:$role,executionRoleArn:"arn:aws:iam::a:role/execution",
        containerDefinitions:$containers}}'
    ;;
  'ecs list-tasks')
    service=''
    while [ "$#" -gt 0 ]; do [ "$1" = --service-name ] && service=$2; shift; done
    if [ "$service" = sproutos-web ]; then count=2; prefix=web; else count=$ACME_COUNT; prefix=acme; fi
    if [ "$count" = 0 ]; then echo '{"taskArns":[]}'; else
      jq -nc --arg prefix "$prefix" --argjson count "$count" '{taskArns:[range(0;$count)|("arn:task/"+$prefix+(.|tostring))]}'
    fi
    ;;
  'ecs describe-tasks')
    if [[ " $* " == *web0* ]]; then count=2; task='arn:aws:ecs:r:a:task-definition/sproutos-web:51'
    else count=$ACME_COUNT; task='arn:aws:ecs:r:a:task-definition/sproutos-acme-worker:9'; fi
    [ "${BAD_TASK_REV:-}" = 1 ] && task='arn:wrong'
    jq -nc --arg task "$task" --argjson count "$count" '{failures:[],tasks:[range(0;$count)|{taskDefinitionArn:$task,lastStatus:"RUNNING",desiredStatus:"RUNNING"}]}'
    ;;
  'iam list-attached-role-policies')
    if [ "$FALLBACK" = true ]; then echo '{"AttachedPolicies":[{"PolicyArn":"arn:aws:iam::a:policy/sproutos-acme-worker"}]}'
    else echo '{"AttachedPolicies":[]}'; fi
    ;;
  'iam get-policy') echo '{"Policy":{"DefaultVersionId":"v3"}}' ;;
  'iam get-policy-version') jq -nc --argjson document "${LIVE_POLICY:-$REVIEWED_POLICY}" '{PolicyVersion:{Document:$document}}' ;;
  *) echo "unexpected aws call: $*" >&2; exit 98 ;;
esac
STUB
chmod +x "$TMP/bin/tofu" "$TMP/bin/aws"

run_phase() {
  local phase=$1
  case "$phase" in
    A) state='{"capacity_enabled":false,"handler_ownership_enabled":false,"fallback_iam_enabled":true}'; capacity=0; ownership=0; fallback=true; count=0 ;;
    C) state='{"capacity_enabled":true,"handler_ownership_enabled":true,"fallback_iam_enabled":true}'; capacity=1; ownership=1; fallback=true; count=2 ;;
    D) state='{"capacity_enabled":true,"handler_ownership_enabled":true,"fallback_iam_enabled":false}'; capacity=1; ownership=1; fallback=false; count=2 ;;
  esac
  if [ "$fallback" = true ]; then action=route53:ChangeResourceRecordSets; resource=arn:aws:route53:::hostedzone/Z1
  else action=s3:GetObject; resource=arn:aws:s3:::bucket/key; fi
  reviewed=$(jq -nc --arg action "$action" --arg resource "$resource" \
    '{Version:"2012-10-17",Statement:[{Effect:"Allow",Action:[$action],Resource:$resource}]}')
  reviewed=${REVIEWED_POLICY_OVERRIDE:-$reviewed}
  ROLLOUT_STATE=$state CAPACITY_ENV=$capacity OWNERSHIP_ENV=$ownership FALLBACK=$fallback ACME_COUNT=$count \
    REVIEWED_POLICY=$reviewed \
    PATH="$TMP/bin:$PATH" NAME_PREFIX=sproutos IMAGE=ghcr.io/mysproutos/sproutos-web:0123456789ab \
    "$ROOT/bin/verify-acme-worker-rollout.sh" "$phase"
}

run_phase A
run_phase C
run_phase D

# A saved stage-two plan intentionally changes the task contract before ECS serves it. Phase-only
# verification must tolerate that planned delta while still refusing a missing live phase-A service.
ACME_LIVE_PHASE_ONLY=1 BASE_CONTRACT_DRIFT=1 run_phase A
if ACME_LIVE_PHASE_ONLY=1 BAD_ROLE=1 run_phase A >"$TMP/phase-role.out" 2>&1; then
  echo "phase-only verifier accepted a live task-role contract mismatch" >&2
  exit 1
fi
grep -q "not the exact reviewed contract" "$TMP/phase-role.out"
if ACME_LIVE_PHASE_ONLY=1 MISSING_ACME_SERVICE=1 run_phase A \
  >"$TMP/missing-acme.out" 2>&1; then
  echo "phase-only verifier accepted a missing live ACME service" >&2
  exit 1
fi
grep -q "ECS service lookup failed" "$TMP/missing-acme.out"

ordered='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["route53:ListResourceRecordSets","route53:ChangeResourceRecordSets"],"Resource":["arn:aws:route53:::hostedzone/Z2","arn:aws:route53:::hostedzone/Z1"],"Condition":{"StringEquals":{"aws:ResourceTag/Environment":["prod","shared"]}}}]}'
reordered='{"Statement":[{"Resource":["arn:aws:route53:::hostedzone/Z1","arn:aws:route53:::hostedzone/Z2"],"Condition":{"StringEquals":{"aws:ResourceTag/Environment":["shared","prod"]}},"Action":["route53:ChangeResourceRecordSets","route53:ListResourceRecordSets"],"Effect":"Allow"}],"Version":"2012-10-17"}'
REVIEWED_POLICY_OVERRIDE=$ordered LIVE_POLICY=$reordered run_phase C

for failure in BAD_PENDING BAD_ROLLOUT BAD_IMAGE BAD_ROLE BAD_ENV BAD_TASK_REV; do
  export "$failure=1"
  if run_phase C >"$TMP/$failure.out" 2>&1; then
    echo "live verifier accepted $failure" >&2
    exit 1
  fi
  unset "$failure"
done

deny='{"Version":"2012-10-17","Statement":[{"Effect":"Deny","Action":["route53:ChangeResourceRecordSets"],"Resource":"arn:aws:route53:::hostedzone/Z1"}]}'
wildcard='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["route53:*"],"Resource":"*"}]}'
equivalent_overgrant='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["route53:ChangeResourceRecordSets","route53:ListHostedZones"],"Resource":"arn:aws:route53:::hostedzone/Z1"}]}'
for policy in "$deny" "$wildcard" "$equivalent_overgrant"; do
  export LIVE_POLICY=$policy
  if run_phase C >"$TMP/policy.out" 2>&1; then
    echo "live verifier accepted non-reviewed IAM semantics" >&2
    exit 1
  fi
  unset LIVE_POLICY
done

echo "live ACME rollout verifier rejects unstable counts, deployments, contracts, and tasks"
