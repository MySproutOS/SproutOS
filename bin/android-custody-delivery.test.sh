#!/usr/bin/env bash
# Deterministic regression test for the metadata preflight and explicit second-stage plan gate.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

cat >"$WORK_DIR/aws" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = "ssm" ] && [ "${2:-}" = "put-parameter" ]; then
  for arg in "$@"; do
    case "$arg" in
      file://*)
        REQUEST_FILE=${arg#file://} AWS_PUT_CALLS="$AWS_PUT_CALLS" python3 <<'PYTHON'
import json
import os

with open(os.environ["REQUEST_FILE"], encoding="utf-8") as source:
    request = json.load(source)
with open(os.environ["AWS_PUT_CALLS"], "a", encoding="utf-8") as output:
    output.write(f"{request['Name']}\t{request['Type']}\n")
PYTHON
        ;;
    esac
  done
  printf '1\n'
  exit 0
fi
if [ "${1:-}" = "sts" ] && [ "${2:-}" = "get-caller-identity" ]; then
  printf '123456789012\n'
  exit 0
fi
filter=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--parameter-filters" ]; then
    filter=$2
    shift 2
  else
    shift
  fi
done
name=${filter#*Values=}
if [ "${MISSING_ANDROID_PARAMETER:-}" = "$name" ]; then
  printf 'None\tNone\n'
else
  printf '%s\tSecureString\n' "$name"
fi
SCRIPT
chmod +x "$WORK_DIR/aws"

cat >"$WORK_DIR/tofu" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$TOFU_CALLS"
if [[ " $* " == *" plan "* ]]; then
  [[ " $* " == *" -var=android_custody_delivery_enabled=true "* ]]
  [[ " $* " == *" -var=android_developer_registration_delivery_enabled=false "* ]]
  for arg in "$@"; do
    case "$arg" in
      -out=*) : >"${arg#-out=}" ;;
    esac
  done
  exit 0
fi
if [[ " $* " == *" show -json "* ]]; then
  python3 <<'PYTHON'
import json
import os

base = "arn:aws:ssm:us-east-1:123456789012:parameter/sproutos/android-custody/"
containers = [
    {"name": "website", "secrets": []},
    {
        "name": "api",
        "secrets": [
            {"name": "APK_SIGNER_TOKEN", "valueFrom": base + "APK_SIGNER_TOKEN"},
            {"name": "APK_SIGNER_OPERATOR_TOKEN", "valueFrom": base + "APK_SIGNER_OPERATOR_TOKEN"},
        ],
    },
    {
        "name": "worker",
        "secrets": [],
    },
]
defect = os.environ.get("MOCK_PLAN_DEFECT")
if defect == "operator-in-worker":
    containers[1]["secrets"] = [
        secret for secret in containers[1]["secrets"]
        if secret["name"] != "APK_SIGNER_OPERATOR_TOKEN"
    ]
    containers[2]["secrets"].append({
        "name": "APK_SIGNER_OPERATOR_TOKEN",
        "valueFrom": base + "APK_SIGNER_OPERATOR_TOKEN",
    })
if defect == "google-in-worker":
    containers[2]["secrets"].append({
        "name": "ANDROID_DEVELOPER_ID_STATUS_API_KEY",
        "valueFrom": base + "ANDROID_DEVELOPER_ID_STATUS_API_KEY",
    })
if defect == "token-extra-arn":
    containers[1]["secrets"][0]["valueFrom"] += "_extra"
execution_policy = {
    "Version": "2012-10-17",
    "Statement": [{
        "Effect": "Allow",
        "Action": ["ssm:GetParameters"],
        "Resource": [
            base + "APK_SIGNER_TOKEN",
            base + "APK_SIGNER_OPERATOR_TOKEN",
        ],
    }],
}
if defect == "broad-execution-role":
    execution_policy["Statement"][0]["Resource"].append(
        base + "ANDROID_DEVELOPER_ID_STATUS_API_KEY"
    )
print(json.dumps({
    "resource_changes": [
        {
            "address": "aws_ecs_task_definition.web",
            "change": {"after": {"container_definitions": json.dumps(containers)}},
        },
        {
            "address": "aws_iam_role_policy.ecs_execution_secrets",
            "change": {"after": {"policy": json.dumps(execution_policy)}},
        },
    ]
}))
PYTHON
  exit 0
fi
exit 1
SCRIPT
chmod +x "$WORK_DIR/tofu"

export AWS_BIN="$WORK_DIR/aws"
export TOFU_BIN="$WORK_DIR/tofu"
export TOFU_CALLS="$WORK_DIR/tofu.calls"
export AWS_PUT_CALLS="$WORK_DIR/aws-put.calls"

cat >"$WORK_DIR/missing.env" <<'ENV'
APK_SIGNER_TOKEN=runtime-only
ENV
if ANDROID_CUSTODY_ONLY=1 AWS_BIN="$WORK_DIR/aws" \
  "$ROOT/bin/put-app-secrets.sh" "$WORK_DIR/missing.env" >/dev/null 2>&1; then
  echo "delivery test failed: custody-only upload accepted a missing operator token" >&2
  exit 1
fi

cat >"$WORK_DIR/equal.env" <<'ENV'
APK_SIGNER_TOKEN=same-token
APK_SIGNER_OPERATOR_TOKEN=same-token
ENV
if ANDROID_CUSTODY_ONLY=1 AWS_BIN="$WORK_DIR/aws" \
  "$ROOT/bin/put-app-secrets.sh" "$WORK_DIR/equal.env" >/dev/null 2>&1; then
  echo "delivery test failed: custody-only upload accepted equal signer tokens" >&2
  exit 1
fi

cat >"$WORK_DIR/distinct.env" <<'ENV'
APK_SIGNER_TOKEN=runtime-only
APK_SIGNER_OPERATOR_TOKEN=operator-only
ENV
ANDROID_CUSTODY_ONLY=1 "$ROOT/bin/put-app-secrets.sh" "$WORK_DIR/distinct.env" >/dev/null
expected_puts=$'/sproutos/android-custody/APK_SIGNER_OPERATOR_TOKEN\tSecureString\n/sproutos/android-custody/APK_SIGNER_TOKEN\tSecureString'
[ "$(sort "$AWS_PUT_CALLS")" = "$expected_puts" ] || {
  echo "delivery test failed: custody upload did not use only the isolated exact parameter names" >&2
  exit 1
}

missing="/sproutos/android-custody/APK_SIGNER_OPERATOR_TOKEN"
if MISSING_ANDROID_PARAMETER="$missing" \
  "$ROOT/bin/plan-android-custody-delivery.sh" "$WORK_DIR/missing.plan" >/dev/null 2>&1; then
  echo "delivery test failed: a missing Android SecureString reached planning" >&2
  exit 1
fi
if [ -e "$TOFU_CALLS" ]; then
  echo "delivery test failed: OpenTofu ran before the SSM metadata preflight passed" >&2
  exit 1
fi

"$ROOT/bin/plan-android-custody-delivery.sh" "$WORK_DIR/ready.plan" >/dev/null
grep -q -- '-var=android_custody_delivery_enabled=true' "$TOFU_CALLS"
grep -q -- '-var=android_developer_registration_delivery_enabled=false' "$TOFU_CALLS"
grep -q 'show -json' "$TOFU_CALLS"

for defect in operator-in-worker google-in-worker broad-execution-role token-extra-arn; do
  if MOCK_PLAN_DEFECT=$defect \
    "$ROOT/bin/plan-android-custody-delivery.sh" "$WORK_DIR/$defect.plan" >/dev/null 2>&1; then
    echo "delivery test failed: saved-plan defect $defect was accepted" >&2
    exit 1
  fi
done

echo "Android custody delivery staging tests passed"
