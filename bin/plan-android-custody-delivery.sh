#!/usr/bin/env bash
# Produce, but never apply, the second-stage plan that injects Android custody credentials.
#
# The first OpenTofu apply must leave android_custody_delivery_enabled=false. After the two
# SecureString parameters are written out of band, this script proves their exact names exist using
# metadata-only DescribeParameters calls, produces a saved enable plan, and verifies that the task
# definition places each credential in only the API and the execution role reads only exact names.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
AWS_BIN=${AWS_BIN:-aws}
TOFU_BIN=${TOFU_BIN:-tofu}
AWS_REGION=${AWS_REGION:-us-east-1}
NAME_PREFIX=${NAME_PREFIX:-sproutos}
PARAMETER_PATH="/${NAME_PREFIX}/application"

if [ "$#" -lt 1 ]; then
  echo "usage: $0 PLAN_FILE [additional tofu plan arguments...]" >&2
  exit 2
fi

PLAN_FILE=$1
shift
case "$PLAN_FILE" in
  /*) ;;
  *) PLAN_FILE="$(pwd)/$PLAN_FILE" ;;
esac

required_parameters=(
  APK_SIGNER_TOKEN
  APK_SIGNER_OPERATOR_TOKEN
)

for short_name in "${required_parameters[@]}"; do
  full_name="${PARAMETER_PATH}/${short_name}"
  metadata=$(
    "$AWS_BIN" ssm describe-parameters \
      --region "$AWS_REGION" \
      --parameter-filters "Key=Name,Option=Equals,Values=${full_name}" \
      --query 'Parameters[0].[Name,Type]' \
      --output text
  )
  if [ "$metadata" != "${full_name}"$'\t'"SecureString" ]; then
    echo "Android custody delivery refused: ${full_name} is missing or is not a SecureString." >&2
    echo "Run ANDROID_CUSTODY_ONLY=1 bin/put-app-secrets.sh, then retry this plan." >&2
    exit 1
  fi
done

"$TOFU_BIN" -chdir="$ROOT/tofu" plan \
  "$@" \
  -var=android_custody_delivery_enabled=true \
  -var=android_developer_registration_delivery_enabled=false \
  -out="$PLAN_FILE"

plan_json=$(mktemp)
chmod 600 "$plan_json"
trap 'rm -f "$plan_json"' EXIT
"$TOFU_BIN" -chdir="$ROOT/tofu" show -json "$PLAN_FILE" >"$plan_json"

PLAN_JSON="$plan_json" PARAMETER_PATH="$PARAMETER_PATH" python3 <<'PYTHON'
import json
import os
import sys

with open(os.environ["PLAN_JSON"], encoding="utf-8") as source:
    plan = json.load(source)

task = next(
    (
        change["change"]["after"]
        for change in plan.get("resource_changes", [])
        if change.get("address") == "aws_ecs_task_definition.web"
    ),
    None,
)
if not task or not task.get("container_definitions"):
    sys.exit("Android custody delivery refused: saved plan has no web task definition.")

execution = next(
    (
        change["change"]["after"]
        for change in plan.get("resource_changes", [])
        if change.get("address") == "aws_iam_role_policy.ecs_execution_secrets"
    ),
    None,
)
if not execution or not execution.get("policy"):
    sys.exit("Android custody delivery refused: saved plan has no ECS execution-role policy.")

containers = {
    container["name"]: container
    for container in json.loads(task["container_definitions"])
}
expected = {
    "APK_SIGNER_TOKEN": "api",
    "APK_SIGNER_OPERATOR_TOKEN": "api",
}
parameter_path = os.environ["PARAMETER_PATH"]
task_secret_arns = {}

for secret, intended_container in expected.items():
    occurrences = []
    for container_name, container in containers.items():
        for candidate in container.get("secrets", []):
            if candidate.get("name") == secret:
                occurrences.append((container_name, candidate.get("valueFrom")))
    required_arn_suffix = f"parameter{parameter_path}/{secret}"
    if occurrences != [(intended_container, next((arn for name, arn in occurrences if name == intended_container), None))]:
        sys.exit(
            f"Android custody delivery refused: {secret} must occur exactly once in {intended_container}; "
            f"found {occurrences!r}."
        )
    if not occurrences[0][1] or required_arn_suffix not in occurrences[0][1]:
        sys.exit(
            f"Android custody delivery refused: {secret} does not reference its exact Parameter Store name."
        )
    task_secret_arns[secret] = occurrences[0][1]

for container_name, container in containers.items():
    if any(
        candidate.get("name") == "ANDROID_DEVELOPER_ID_STATUS_API_KEY"
        for candidate in container.get("secrets", [])
    ):
        sys.exit(
            "Android custody delivery refused: the independent Google credential entered "
            f"the {container_name} container."
        )

policy = json.loads(execution["policy"])
android_parameter_arns = []
for statement in policy.get("Statement", []):
    actions = statement.get("Action", [])
    if isinstance(actions, str):
        actions = [actions]
    if "ssm:GetParameters" not in actions:
        continue
    resources = statement.get("Resource", [])
    if isinstance(resources, str):
        resources = [resources]
    android_parameter_arns.extend(
        arn for arn in resources
        if "APK_SIGNER" in arn or "ANDROID_DEVELOPER" in arn
    )

expected_arns = sorted(task_secret_arns.values())
if sorted(android_parameter_arns) != expected_arns:
    sys.exit(
        "Android custody delivery refused: execution-role Android SSM resources must be the two "
        f"exact signer names; found {sorted(android_parameter_arns)!r}."
    )

print("Android custody metadata, task placement, and exact execution-role SSM plan verified.")
PYTHON

echo "Saved enable plan: $PLAN_FILE"
echo "Review this exact plan before a separate explicit apply; this script never applies it."
