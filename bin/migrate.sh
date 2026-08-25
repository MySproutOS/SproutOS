#!/usr/bin/env bash
#
# Apply database migrations and seeds, from CI, on push to main.
#
# ## Why this is not just `pnpm migrate:deploy` in a job
#
# The control-plane database lives in a subnet with **no route to any gateway** — see `network.tf`,
# where that is a deliberate stronger statement than a security group. A GitHub runner cannot reach
# it, and the ways to make it reachable are all worse than this script: a public RDS instance
# allowlisting GitHub's published ranges is thousands of addresses that change, and a bastion is a
# host to patch that exists only for this.
#
# So CI *drives* the migration without *running* it. `ssm:SendCommand` executes on an instance that
# is already inside the VPC and already holds the credentials, and the command's exit status comes
# back here. Nothing about the database's reachability changes.
#
# ## Which instance
#
# The idle colour's, not whichever answers first. `fill-idle.sh` has just replaced those instances
# from the release being deployed, so they carry *this* commit's migrator; the live colour is still
# running the previous release and may not have the migration files at all. Running the old
# migrator would report success having applied nothing.
#
# ## Why running it once here is safe alongside anything else
#
# `apps/dbmigrator/src/deploy.ts` takes a Postgres advisory lock on a pinned key for the length of
# the run, and `seed-cli.ts` takes a different one — different because the two are separate
# operations that can each fail alone, and sharing a key would make them look atomic and make a seed
# wait behind a migration it does not depend on.
#
# `&&`, so the seeds run only if the migrations did. A seed inserts into tables the migrations
# create; running it against a half-migrated schema is how you get an error that names a column
# instead of the real problem. That was written for many replicas starting at once; it holds just as well for a CI job
# racing a hand-run migration. This script does not need to be the only writer, only a correct one.
set -euo pipefail

: "${NAME_PREFIX:?NAME_PREFIX is not set}"
: "${WEBSITE_RULE_ARN:?WEBSITE_RULE_ARN is not set}"

# The colour currently carrying traffic, read the same way `cutover.sh` reads it: the target group
# with a non-zero weight. The one to migrate from is the other.
live_arn=$(aws elbv2 describe-rules --rule-arns "$WEBSITE_RULE_ARN" \
  --query 'Rules[0].Actions[0].ForwardConfig.TargetGroups[?Weight>`0`].TargetGroupArn | [0]' \
  --output text)

group_arn_of() {
  aws elbv2 describe-target-groups --names "$NAME_PREFIX-web-$1" \
    --query 'TargetGroups[0].TargetGroupArn' --output text
}

blue=$(group_arn_of blue)
green=$(group_arn_of green)

if [ "$live_arn" = "$blue" ]; then
  idle=green
elif [ "$live_arn" = "$green" ]; then
  idle=blue
else
  # Nothing is serving yet — a first deploy. Either colour will do, and blue is the one
  # `fill-idle.sh` starts with.
  echo "no colour is live; treating blue as the one just filled" >&2
  idle=blue
fi

echo "migrating from the $idle instances"

instance=$(aws autoscaling describe-auto-scaling-groups \
  --auto-scaling-group-names "$NAME_PREFIX-web-$idle" \
  --query 'AutoScalingGroups[0].Instances[?LifecycleState==`InService`].InstanceId | [0]' \
  --output text)

if [ -z "$instance" ] || [ "$instance" = "None" ]; then
  echo "no InService instance in $NAME_PREFIX-web-$idle to migrate from" >&2
  exit 1
fi

echo "using $instance"

# `set -a` so the env file's assignments are exported into the node process. The file is the same
# one the service unit sources, so this uses exactly the credentials the application does — there is
# no second copy of the database URL to drift.
command_id=$(aws ssm send-command \
  --instance-ids "$instance" \
  --document-name AWS-RunShellScript \
  --comment "migrate ${GITHUB_SHA:-manual}" \
  --parameters 'commands=["set -a; . /etc/sproutos/env; set +a; cd /opt/sproutos/api && node migrate.mjs && node seed.mjs"]' \
  --query 'Command.CommandId' --output text)

echo "command $command_id"

# Poll rather than `aws ssm wait`, which has no waiter for a command reaching a terminal state.
for _ in $(seq 1 60); do
  sleep 5
  status=$(aws ssm get-command-invocation --command-id "$command_id" --instance-id "$instance" \
    --query 'Status' --output text 2>/dev/null || echo Pending)
  case "$status" in
    Success|Failed|Cancelled|TimedOut) break ;;
  esac
done

# The migrator's own output is the interesting part — which migrations it applied, or that the
# schema was already current. Printed whether it passed or failed, because a failure's stack is the
# whole reason to look.
aws ssm get-command-invocation --command-id "$command_id" --instance-id "$instance" \
  --query 'StandardOutputContent' --output text || true
aws ssm get-command-invocation --command-id "$command_id" --instance-id "$instance" \
  --query 'StandardErrorContent' --output text >&2 || true

if [ "$status" != "Success" ]; then
  echo "migration $status" >&2
  exit 1
fi

echo "migrations and seeds applied"
