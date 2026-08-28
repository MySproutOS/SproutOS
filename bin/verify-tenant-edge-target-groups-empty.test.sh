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
printf '%s\n' "$PLAN_JSON"
STUB
cat >"$TMP/bin/aws" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
case "$1 $2" in
  'elbv2 describe-target-groups')
    if [ "${ATTACHED:-}" = 1 ] && [[ "$*" == *http-blue* ]]; then lbs='["arn:lb"]'; else lbs='[]'; fi
    jq -nc --argjson lbs "$lbs" '{TargetGroups:[{LoadBalancerArns:$lbs}]}'
    ;;
  'elbv2 describe-target-health')
    if [ "${REGISTERED:-}" = 1 ] && [[ "$*" == *http-blue* ]]; then targets='[{"Target":{}}]'; else targets='[]'; fi
    jq -nc --argjson targets "$targets" '{TargetHealthDescriptions:$targets}'
    ;;
  *) exit 98 ;;
esac
STUB
chmod +x "$TMP/bin/tofu" "$TMP/bin/aws"

plan() {
  jq -nc --argjson count "$1" '{resource_changes:[range(0;$count) as $i | {
    address: (["aws_lb_target_group.tenant_http[\"blue\"]","aws_lb_target_group.tenant_http[\"green\"]","aws_lb_target_group.tenant_https[\"blue\"]","aws_lb_target_group.tenant_https[\"green\"]"][$i]),
    change:{actions:["update"],before:{arn:(["arn:http-blue","arn:http-green","arn:https-blue","arn:https-green"][$i]),proxy_protocol_v2:false},after:{proxy_protocol_v2:true}}
  }]}'
}
run_check() {
  PLAN_JSON=$1 PATH="$TMP/bin:$PATH" "$ROOT/bin/verify-tenant-edge-target-groups-empty.sh" ignored.tfplan
}

run_check "$(plan 4)"
for mode in short attached registered; do
  case "$mode" in
    short) command=(run_check "$(plan 3)") ;;
    attached) command=(env ATTACHED=1 PLAN_JSON="$(plan 4)" PATH="$TMP/bin:$PATH" "$ROOT/bin/verify-tenant-edge-target-groups-empty.sh" ignored.tfplan) ;;
    registered) command=(env REGISTERED=1 PLAN_JSON="$(plan 4)" PATH="$TMP/bin:$PATH" "$ROOT/bin/verify-tenant-edge-target-groups-empty.sh" ignored.tfplan) ;;
  esac
  if "${command[@]}" >"$TMP/$mode.out" 2>&1; then
    echo "target-group verifier accepted $mode state" >&2
    exit 1
  fi
done

echo "tenant-edge PPv2 bootstrap requires all four target groups empty and unassociated"
