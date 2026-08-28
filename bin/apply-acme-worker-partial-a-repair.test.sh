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
cp "$ROOT/bin/apply-acme-worker-partial-a-repair.sh" "$TMP/bin/"

cat >"$TMP/bin/check-acme-worker-partial-a-repair-plan.sh" <<'STUB'
#!/usr/bin/env bash
echo check >>"$CALLS"
[ "${MUTATE_VERIFIED:-}" != 1 ] || { chmod 600 "$1"; printf tampered >>"$1"; }
echo 'A->A-partial-repair'
STUB
cat >"$TMP/bin/verify-acme-worker-partial-a.sh" <<'STUB'
#!/usr/bin/env bash
echo verify-partial >>"$CALLS"
[ "${FAIL_PARTIAL:-}" != 1 ]
STUB
cat >"$TMP/bin/verify-tenant-edge-target-groups-empty.sh" <<'STUB'
#!/usr/bin/env bash
echo verify-target-groups >>"$CALLS"
[ "${FAIL_TARGETS:-}" != 1 ]
STUB
cat >"$TMP/bin/handoff-ecs-task-definitions.sh" <<'STUB'
#!/usr/bin/env bash
echo "handoff-and-verify $1" >>"$CALLS"
[ "${FAIL_HANDOFF:-}" != 1 ]
STUB
cat >"$TMP/bin/tofu" <<'STUB'
#!/usr/bin/env bash
echo "apply ${*: -1}" >>"$CALLS"
STUB
chmod +x "$TMP/bin/"*.sh "$TMP/bin/tofu"
printf saved-plan-bytes >"$TMP/saved.tfplan"

run_repair() {
  CALLS="$TMP/calls" PATH="$TMP/bin:$PATH" NAME_PREFIX=sproutos \
    IMAGE=ghcr.io/mysproutos/sproutos-web:0123456789ab \
    "$TMP/bin/apply-acme-worker-partial-a-repair.sh" "$TMP/saved.tfplan"
}

run_repair
test "$(sed -n '1,3p' "$TMP/calls")" = $'check\nverify-partial\nverify-target-groups'
sed -n '4p' "$TMP/calls" | grep -Eq '^apply .*/verified\.tfplan$'
test "$(sed -n '5p' "$TMP/calls")" = 'handoff-and-verify A'
if grep -q "apply $TMP/saved.tfplan" "$TMP/calls"; then
  echo "repair wrapper applied the caller-owned plan path" >&2
  exit 1
fi

: >"$TMP/calls"
if CALLS="$TMP/calls" PATH="$TMP/bin:$PATH" NAME_PREFIX=sproutos \
  IMAGE=ghcr.io/mysproutos/sproutos-web:latest \
  "$TMP/bin/apply-acme-worker-partial-a-repair.sh" "$TMP/saved.tfplan" \
  >"$TMP/mutable-image.out" 2>&1; then
  echo "repair wrapper accepted a mutable image tag" >&2
  exit 1
fi
grep -q 'immutable 12-character lowercase Git SHA tag' "$TMP/mutable-image.out"
test ! -s "$TMP/calls"

for scenario in partial targets; do
  : >"$TMP/calls"
  case "$scenario" in
    partial) failure=FAIL_PARTIAL ;;
    targets) failure=FAIL_TARGETS ;;
  esac
  if env "$failure=1" CALLS="$TMP/calls" PATH="$TMP/bin:$PATH" NAME_PREFIX=sproutos \
    IMAGE=ghcr.io/mysproutos/sproutos-web:0123456789ab \
    "$TMP/bin/apply-acme-worker-partial-a-repair.sh" "$TMP/saved.tfplan" \
    >"$TMP/$scenario.out" 2>&1; then
    echo "repair applied after failed $scenario precondition" >&2
    exit 1
  fi
  if grep -q '^apply ' "$TMP/calls"; then
    echo "repair reached apply after failed $scenario precondition" >&2
    exit 1
  fi
done

: >"$TMP/calls"
if MUTATE_VERIFIED=1 run_repair >"$TMP/mutation.out" 2>&1; then
  echo "repair applied saved-plan bytes changed after verification" >&2
  exit 1
fi
grep -q 'verified saved-plan bytes changed after repair review' "$TMP/mutation.out"
if grep -q '^apply ' "$TMP/calls"; then
  echo "repair reached apply after saved-plan mutation" >&2
  exit 1
fi

: >"$TMP/calls"
if FAIL_HANDOFF=1 run_repair >"$TMP/handoff.out" 2>&1; then
  echo "repair reported success after full phase-A verification failed" >&2
  exit 1
fi
grep -q '^apply ' "$TMP/calls"
grep -q '^handoff-and-verify A$' "$TMP/calls"

echo "partial-A repair wrapper proves exact preconditions, protects plan bytes, and requires full handoff"
