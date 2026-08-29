#!/usr/bin/env bash
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
OIDC_TF="$HERE/../tofu/oidc.tf"
DEPLOY_SCRIPT="$HERE/deploy-ecs-acme-worker.sh"

statement() {
  local sid=$1
  awk -v sid="$sid" '
    index($0, "= \"" sid "\"") { found = 1 }
    found { print }
    found && /^      },$/ { exit }
  ' "$OIDC_TF"
}

expect_line() {
  local description=$1 expected=$2 actual=$3
  if [ "$actual" != "$expected" ]; then
    echo "$description" >&2
    echo "expected: $expected" >&2
    echo "actual:   $actual" >&2
    exit 1
  fi
}

# Keep this inventory tied to the actual child script. `wait services-stable` polls
# DescribeServices, so it needs no additional IAM action beyond the four ECS APIs below.
script_ecs_calls=$(sed -nE 's/.*aws ecs ([a-z-]+).*/\1/p' "$DEPLOY_SCRIPT" | sort -u | paste -sd, -)
expect_line "unexpected ACME deploy ECS API surface" \
  "describe-services,describe-task-definition,register-task-definition,update-service,wait" \
  "$script_ecs_calls"

register=$(statement RegisterWebTaskDefinitions)
grep -Fq '"ecs:RegisterTaskDefinition"' <<<"$register"
grep -Fq 'Resource = "*"' <<<"$register"

read_state=$(statement ReadWebDeploymentState)
for action in ecs:DescribeServices ecs:DescribeTaskDefinition; do
  grep -Fq "\"$action\"" <<<"$read_state"
done
grep -Fq 'Resource = "*"' <<<"$read_state"

# Mutating service access is exactly the two services released by deploy-ecs-web.sh. A wildcard
# or a third service here would let a compromised release workflow replace an unrelated workload.
update=$(statement UpdateTheDeployedEcsServices)
grep -Fq '"ecs:UpdateService"' <<<"$update"
expect_line "deploy role must update exactly web and ACME worker" \
  'aws_ecs_service.acme_worker.id,aws_ecs_service.web.id' \
  "$(grep -oE 'aws_ecs_service\.[a-z_]+\.id' <<<"$update" | sort -u | paste -sd, -)"
if grep -Fq 'Resource = "*"' <<<"$update"; then
  echo "deploy role may not update every ECS service" >&2
  exit 1
fi

# RegisterTaskDefinition performs PassRole validation for both taskRoleArn and executionRoleArn.
# These are the public task role, the isolated ACME task role, and their shared execution role—no
# unrelated IAM role and no wildcard.
pass_roles=$(statement PassOnlyDeployedTaskRolesToECS)
grep -Fq '"iam:PassRole"' <<<"$pass_roles"
expect_line "deploy role must pass exactly the deployed task roles" \
  'aws_iam_role.acme_task.arn,aws_iam_role.ecs_execution.arn,aws_iam_role.task.arn' \
  "$(grep -oE 'aws_iam_role\.[a-z_]+\.arn' <<<"$pass_roles" | sort -u | paste -sd, -)"
grep -Fq '"iam:PassedToService" = "ecs-tasks.amazonaws.com"' <<<"$pass_roles"
if grep -Fq 'Resource = "*"' <<<"$pass_roles"; then
  echo "deploy role may not pass every IAM role" >&2
  exit 1
fi

echo "deploy role policy matches the complete, scoped ACME release API surface"
