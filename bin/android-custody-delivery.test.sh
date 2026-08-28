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
  printf '1\n'
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

base = "arn:aws:ssm:us-east-1:123456789012:parameter/sproutos/application/"
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
        "secrets": [
            {
                "name": "ANDROID_DEVELOPER_ID_STATUS_API_KEY",
                "valueFrom": base + "ANDROID_DEVELOPER_ID_STATUS_API_KEY",
            }
        ],
    },
]
print(json.dumps({
    "resource_changes": [{
        "address": "aws_ecs_task_definition.web",
        "change": {"after": {"container_definitions": json.dumps(containers)}},
    }]
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

cat >"$WORK_DIR/missing.env" <<'ENV'
APK_SIGNER_TOKEN=runtime-only
ANDROID_DEVELOPER_ID_STATUS_API_KEY=developer-status
ENV
if ANDROID_CUSTODY_ONLY=1 AWS_BIN="$WORK_DIR/aws" \
  "$ROOT/bin/put-app-secrets.sh" "$WORK_DIR/missing.env" >/dev/null 2>&1; then
  echo "delivery test failed: custody-only upload accepted a missing operator token" >&2
  exit 1
fi

cat >"$WORK_DIR/equal.env" <<'ENV'
APK_SIGNER_TOKEN=same-token
APK_SIGNER_OPERATOR_TOKEN=same-token
ANDROID_DEVELOPER_ID_STATUS_API_KEY=developer-status
ENV
if ANDROID_CUSTODY_ONLY=1 AWS_BIN="$WORK_DIR/aws" \
  "$ROOT/bin/put-app-secrets.sh" "$WORK_DIR/equal.env" >/dev/null 2>&1; then
  echo "delivery test failed: custody-only upload accepted equal signer tokens" >&2
  exit 1
fi

missing="/sproutos/application/APK_SIGNER_OPERATOR_TOKEN"
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
grep -q 'show -json' "$TOFU_CALLS"

echo "Android custody delivery staging tests passed"
