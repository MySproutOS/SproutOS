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
printf '%s\n' '#!/usr/bin/env bash' 'printf "%s\\n" "$PLAN_JSON"' >"$TMP/bin/tofu"
chmod +x "$TMP/bin/tofu"

phase_a='{"capacity_enabled":false,"handler_ownership_enabled":false,"fallback_iam_enabled":true}'
repair='[
  ["aws_ecs_service.acme_worker",["create"]],
  ["aws_ecs_task_definition.acme_worker",["delete","create"]],
  ["aws_ecs_task_definition.web",["delete","create"]],
  ["aws_launch_template.ecs",["update"]]
]'
image=ghcr.io/mysproutos/sproutos-web:0123456789ab
gzip_data=$(TOFU_DIR="$ROOT/tofu" "$ROOT/bin/render-ecs-launch-template-user-data.sh" sproutos \
  | gzip -c | base64 | tr -d '\n')
plan() {
  jq -nc --argjson before "$1" --argjson after "$2" --argjson changes "$3" \
    --arg image "$image" --arg gzip "$gzip_data" '{
    output_changes:{acme_worker_rollout_state:{before:$before,after:$after}},
    resource_changes:([$changes[] | .[0] as $address | {
      address:$address,
      change:{actions:.[1],after:(
        if $address == "aws_ecs_task_definition.web" then {
          family:"sproutos-web",network_mode:"bridge",cpu:"896",memory:"640",
          task_role_arn:"arn:aws:iam::a:role/sproutos-task",
          execution_role_arn:"arn:aws:iam::a:role/sproutos-ecs-execution",
          container_definitions:(["website","api","worker"] | map({name:.,image:$image,environment:(
            if . == "worker" then [
              {name:"ACME_JOBS_ENABLED",value:"0"},
              {name:"ACME_HANDLER_OWNERSHIP_ENABLED",value:"0"}
            ] else [] end
          )}) | tojson)
        } elif $address == "aws_ecs_task_definition.acme_worker" then {
          family:"sproutos-acme-worker",network_mode:"bridge",cpu:"128",memory:"256",
          task_role_arn:"arn:aws:iam::a:role/sproutos-acme-task",
          execution_role_arn:"arn:aws:iam::a:role/sproutos-acme-execution",
          container_definitions:([{name:"acme-worker",image:$image,environment:[
            {name:"WORKER_PROFILE",value:"acme"},
            {name:"ACME_ACCOUNT_KEY_SECRET_ID",value:"account-key-id"}
          ]}] | tojson)
        } elif $address == "aws_ecs_service.acme_worker" then {
          name:"sproutos-acme-worker",cluster:"arn:aws:ecs:r:a:cluster/sproutos",desired_count:0,
          capacity_provider_strategy:[{base:null,capacity_provider:"sproutos-ec2",weight:100}],
          deployment_circuit_breaker:[{enable:true,rollback:true}],
          deployment_maximum_percent:150,deployment_minimum_healthy_percent:100,
          availability_zone_rebalancing:"ENABLED",
          scheduling_strategy:"REPLICA",enable_execute_command:false,enable_ecs_managed_tags:false,
          deployment_controller:[],network_configuration:[],service_registries:[],
          alarms:[],force_delete:null,force_new_deployment:null,health_check_grace_period_seconds:null,
          propagate_tags:null,service_connect_configuration:[],volume_configuration:[],
          vpc_lattice_configurations:[],timeouts:null,wait_for_steady_state:false,
          tags:{ManagedBy:"OpenTofu",Project:"SproutOS"},
          tags_all:{ManagedBy:"OpenTofu",Project:"SproutOS"},
          ordered_placement_strategy:[
            {field:"attribute:ecs.availability-zone",type:"spread"},
            {field:"memory",type:"binpack"}
          ],
          placement_constraints:[{expression:"",type:"distinctInstance"}],load_balancer:[]
        } elif $address == "aws_launch_template.ecs" then {
          id:"lt-012345",name:"sproutos-ecs-test",latest_version:null,default_version:1,user_data:$gzip
        }
        else {} end
      ),before:(if $address == "aws_launch_template.ecs" then {
        id:"lt-012345",name:"sproutos-ecs-test",latest_version:1,default_version:1,user_data:"old",
        metadata_options:[{http_endpoint:"",http_protocol_ipv6:"",http_put_response_hop_limit:2,http_tokens:"required",instance_metadata_tags:""}]
      } else {} end),after_unknown:(
        if $address == "aws_launch_template.ecs" then {latest_version:true}
        elif $address == "aws_ecs_service.acme_worker" then {task_definition:true}
        else {} end
      )}
    }] + [{
      address:"aws_secretsmanager_secret.acme_account_key",
      change:{actions:["no-op"],after:{id:"account-key-id"}}
    },{
      address:"aws_ecs_cluster.main",
      change:{actions:["no-op"],after:{id:"arn:aws:ecs:r:a:cluster/sproutos",name:"sproutos"}}
    },{
      address:"aws_ecs_capacity_provider.main",
      change:{actions:["no-op"],after:{name:"sproutos-ec2"}}
    }])
  }
  | .resource_changes |= map(
      if .address == "aws_ecs_task_definition.web" or .address == "aws_ecs_task_definition.acme_worker"
      then .change.before = (.change.after
        | .container_definitions |= (fromjson | map(.image = "old:image") | tojson)
        | . + {
            arn:"arn:old",arn_without_revision:"arn:old",id:.family,revision:1,
            ipc_mode:"",pid_mode:"",requires_compatibilities:[]
          })
      elif .address == "aws_launch_template.ecs"
      then .change.after.metadata_options = [{
        http_endpoint:"",http_protocol_ipv6:"disabled",http_put_response_hop_limit:2,
        http_tokens:"required",instance_metadata_tags:""
      }]
      else . end
    )'
}
run_check() {
  PLAN_JSON=$1 PATH="$TMP/bin:$PATH" NAME_PREFIX=sproutos IMAGE="$image" \
    "$ROOT/bin/check-acme-worker-partial-a-repair-plan.sh" ignored.tfplan
}

test "$(run_check "$(plan "$phase_a" "$phase_a" "$repair")")" = "A->A-partial-repair"
if PLAN_JSON="$(plan "$phase_a" "$phase_a" "$repair")" PATH="$TMP/bin:$PATH" \
  NAME_PREFIX=sproutos IMAGE=ghcr.io/mysproutos/sproutos-web:latest \
  "$ROOT/bin/check-acme-worker-partial-a-repair-plan.sh" ignored.tfplan \
  >"$TMP/mutable-image.out" 2>&1; then
  echo "partial-A guard accepted a mutable image tag" >&2
  exit 1
fi
grep -q 'immutable 12-character lowercase Git SHA tag' "$TMP/mutable-image.out"

phase_b='{"capacity_enabled":true,"handler_ownership_enabled":false,"fallback_iam_enabled":true}'
for bad_plan in \
  "$(plan "$phase_b" "$phase_b" "$repair")" \
  "$(plan "$phase_a" "$phase_b" "$repair")" \
  "$(plan "$phase_a" "$phase_a" "$(jq -c '.[0:3]' <<<"$repair")")" \
  "$(plan "$phase_a" "$phase_a" "$(jq -c '. + [["aws_iam_policy.application",["update"]]]' <<<"$repair")")" \
  "$(plan "$phase_a" "$phase_a" "$(jq -c 'map(if .[0] == "aws_ecs_service.acme_worker" then [.[0],["update"]] else . end)' <<<"$repair")")"
do
  if run_check "$bad_plan" >"$TMP/rejected.out" 2>&1; then
    echo "partial-A guard accepted a wrong phase or action set" >&2
    exit 1
  fi
done

wrong_image=$(plan "$phase_a" "$phase_a" "$repair" | sed "s#${image}#wrong:image#g")
if run_check "$wrong_image" >"$TMP/image.out" 2>&1; then
  echo "partial-A guard accepted a different task image" >&2
  exit 1
fi
bad_gzip=$(plan "$phase_a" "$phase_a" "$repair" | jq -c '
  (.resource_changes[] | select(.address == "aws_launch_template.ecs").change.after.user_data) = "bm90LWd6aXA="
')
if run_check "$bad_gzip" >"$TMP/gzip.out" 2>&1; then
  echo "partial-A guard accepted non-gzip launch-template user data" >&2
  exit 1
fi
missing_explicit_flag=$(plan "$phase_a" "$phase_a" "$repair" | jq -c '
  (.resource_changes[] | select(.address == "aws_ecs_task_definition.web").change.after.container_definitions) |=
    (fromjson | map(if .name == "worker" then
      .environment |= map(select(.name != "ACME_HANDLER_OWNERSHIP_ENABLED"))
    else . end) | tojson)
')
shared_role=$(plan "$phase_a" "$phase_a" "$repair" | jq -c '
  (.resource_changes[] | select(.address == "aws_ecs_task_definition.acme_worker").change.after.task_role_arn) =
    "arn:aws:iam::a:role/sproutos-task"
')
wrong_account_key=$(plan "$phase_a" "$phase_a" "$repair" | jq -c '
  (.resource_changes[] | select(.address == "aws_secretsmanager_secret.acme_account_key").change.after.id) = "other-key"
')
oversized_data=$(head -c 17000 /dev/urandom | gzip -c | base64 | tr -d '\n')
oversized=$(plan "$phase_a" "$phase_a" "$repair" | jq -c --arg data "$oversized_data" '
  (.resource_changes[] | select(.address == "aws_launch_template.ecs").change.after.user_data) = $data
')
for contract in "$missing_explicit_flag" "$shared_role" "$wrong_account_key" "$oversized"; do
  if run_check "$contract" >"$TMP/contract.out" 2>&1; then
    echo "partial-A guard accepted an unsafe task or launch-template contract" >&2
    exit 1
  fi
done
nonzero_service=$(plan "$phase_a" "$phase_a" "$repair" | jq -c '
  (.resource_changes[] | select(.address == "aws_ecs_service.acme_worker").change.after.desired_count) = 2
')
unsafe_service=$(plan "$phase_a" "$phase_a" "$repair" | jq -c '
  (.resource_changes[] | select(.address == "aws_ecs_service.acme_worker").change.after.deployment_minimum_healthy_percent) = 0
')
lt_identity_change=$(plan "$phase_a" "$phase_a" "$repair" | jq -c '
  (.resource_changes[] | select(.address == "aws_launch_template.ecs").change.after.default_version) = 2
')
for contract in "$nonzero_service" "$unsafe_service" "$lt_identity_change"; do
  if run_check "$contract" >"$TMP/service-contract.out" 2>&1; then
    echo "partial-A guard accepted unsafe capacity, deployment, or launch-template identity" >&2
    exit 1
  fi
done

privileged_worker=$(plan "$phase_a" "$phase_a" "$repair" | jq -c '
  (.resource_changes[] | select(.address == "aws_ecs_task_definition.web").change.after.container_definitions) |=
    (fromjson | map(if .name == "worker" then .privileged = true else . end) | tojson)
')
extra_acme_secret=$(plan "$phase_a" "$phase_a" "$repair" | jq -c '
  (.resource_changes[] | select(.address == "aws_ecs_task_definition.acme_worker").change.after.container_definitions) |=
    (fromjson | map(if .name == "acme-worker" then
      .secrets = ((.secrets // []) + [{name:"UNREVIEWED",valueFrom:"arn:secret"}])
    else . end) | tojson)
')
service_propagates_tags=$(plan "$phase_a" "$phase_a" "$repair" | jq -c '
  (.resource_changes[] | select(.address == "aws_ecs_service.acme_worker").change.after.propagate_tags) = "SERVICE"
')
lt_image_changed=$(plan "$phase_a" "$phase_a" "$repair" | jq -c '
  (.resource_changes[] | select(.address == "aws_launch_template.ecs").change.after.image_id) = "ami-unreviewed"
')
lt_imds_changed=$(plan "$phase_a" "$phase_a" "$repair" | jq -c '
  (.resource_changes[] | select(.address == "aws_launch_template.ecs").change.after.metadata_options[0].http_tokens) = "optional"
')
lt_ipv6_unreviewed_before=$(plan "$phase_a" "$phase_a" "$repair" | jq -c '
  (.resource_changes[] | select(.address == "aws_launch_template.ecs").change.before.metadata_options[0].http_protocol_ipv6) = "enabled"
')
for payload in "$privileged_worker" "$extra_acme_secret" "$service_propagates_tags" "$lt_image_changed" "$lt_imds_changed" "$lt_ipv6_unreviewed_before"; do
  if run_check "$payload" >"$TMP/nested-payload.out" 2>&1; then
    echo "partial-A guard accepted an unreviewed nested provider payload" >&2
    exit 1
  fi
done

# The ordinary rollout checker must continue to reject unchanged A->A plans.
cp "$ROOT/bin/check-acme-worker-rollout-plan.sh" "$TMP/bin/ordinary-check"
chmod +x "$TMP/bin/ordinary-check"
if PLAN_JSON="$(plan "$phase_a" "$phase_a" "$repair")" PATH="$TMP/bin:$PATH" \
  "$TMP/bin/ordinary-check" ignored.tfplan >"$TMP/ordinary.out" 2>&1; then
  echo "ordinary adjacent-phase guard was broadened to accept A->A" >&2
  exit 1
fi
grep -q 'only adjacent transitions are allowed' "$TMP/ordinary.out"

echo "partial-A plan guard accepts only the exact recovery without broadening adjacent transitions"
