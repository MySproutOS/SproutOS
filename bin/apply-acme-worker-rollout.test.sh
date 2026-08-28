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
cp "$ROOT/bin/apply-acme-worker-rollout.sh" "$TMP/bin/"

cat >"$TMP/bin/check-acme-worker-rollout-plan.sh" <<'STUB'
#!/usr/bin/env bash
echo check >>"$CALLS"
[ "${MUTATE_VERIFIED:-}" != 1 ] || { chmod 600 "$1"; printf tampered >>"$1"; }
echo "$TRANSITION"
STUB
cat >"$TMP/bin/verify-acme-worker-rollout.sh" <<'STUB'
#!/usr/bin/env bash
echo "verify $1" >>"$CALLS"
[ "${FAIL_VERIFY:-}" != "$1" ]
STUB
cat >"$TMP/bin/verify-tenant-edge-target-groups-empty.sh" <<'STUB'
#!/usr/bin/env bash
echo verify-target-groups >>"$CALLS"
STUB
cat >"$TMP/bin/handoff-ecs-task-definitions.sh" <<'STUB'
#!/usr/bin/env bash
echo "handoff $1" >>"$CALLS"
STUB
cat >"$TMP/bin/tofu" <<'STUB'
#!/usr/bin/env bash
echo "apply ${*: -1}" >>"$CALLS"
STUB
chmod +x "$TMP/bin/"*.sh "$TMP/bin/tofu"
printf 'saved-plan-bytes' >"$TMP/saved.tfplan"

run_rollout() {
  TRANSITION=$1 CALLS="$TMP/calls" PATH="$TMP/bin:$PATH" NAME_PREFIX=sproutos \
    IMAGE=ghcr.io/mysproutos/sproutos-web:0123456789ab \
    "$TMP/bin/apply-acme-worker-rollout.sh" "$TMP/saved.tfplan"
}

run_rollout 'A->B'
test "$(sed -n '1,2p' "$TMP/calls")" = $'check\nverify A'
sed -n '3p' "$TMP/calls" | grep -Eq '^apply .*/verified\.tfplan$'
test "$(sed -n '4p' "$TMP/calls")" = 'handoff B'
if grep -q "apply $TMP/saved.tfplan" "$TMP/calls"; then
  echo "rollout wrapper applied the caller-owned plan path" >&2
  exit 1
fi

: >"$TMP/calls"
run_rollout 'NONE->A'
test "$(sed -n '1,2p' "$TMP/calls")" = $'check\nverify-target-groups'
sed -n '3p' "$TMP/calls" | grep -Eq '^apply .*/verified\.tfplan$'
test "$(sed -n '4p' "$TMP/calls")" = 'handoff A'

: >"$TMP/calls"
run_rollout 'C->D'
test "$(sed -n '1,2p' "$TMP/calls")" = $'check\nverify C'
sed -n '3p' "$TMP/calls" | grep -Eq '^apply .*/verified\.tfplan$'
test "$(sed -n '4p' "$TMP/calls")" = 'verify D'

: >"$TMP/calls"
if FAIL_VERIFY=A run_rollout 'A->B' >"$TMP/failure.out" 2>&1; then
  echo "rollout wrapper applied after failed live precondition" >&2
  exit 1
fi
test "$(sed -n '1,2p' "$TMP/calls")" = $'check\nverify A'

: >"$TMP/calls"
if MUTATE_VERIFIED=1 run_rollout 'A->B' >"$TMP/mutation.out" 2>&1; then
  echo "rollout wrapper applied plan bytes changed after verification" >&2
  exit 1
fi
grep -q 'verified saved-plan bytes changed after review' "$TMP/mutation.out"
if grep -q '^apply ' "$TMP/calls"; then
  echo "rollout wrapper reached apply after saved-plan mutation" >&2
  exit 1
fi

echo "ACME rollout wrapper proves live state before apply and after handoff"
