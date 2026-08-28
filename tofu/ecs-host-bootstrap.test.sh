#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
test_root="$(mktemp -d)"
mock_bin="$(mktemp -d)"
cleanup() {
  chmod -R u+w "$test_root" 2>/dev/null || true
  find "$test_root" "$mock_bin" -depth -delete 2>/dev/null || true
}
trap cleanup EXIT

call_log="$test_root/calls"
mkdir -p "$test_root/etc/ecs"

fail() {
  echo "$1" >&2
  exit 1
}
assert_equal() {
  local actual="$1"
  local expected="$2"
  local description="$3"
  if [[ "$actual" != "$expected" ]]; then
    fail "$description: expected $expected, found $actual"
  fi
}

make_mock() {
  local name="$1"
  shift
  {
    printf '#!/usr/bin/env bash\nset -euo pipefail\n'
    printf '%s\n' "$@"
  } >"$mock_bin/$name"
  chmod 0755 "$mock_bin/$name"
}

make_mock rpm \
  'case "$*" in "-q docker") echo docker-25.0.16-1.amzn2023.0.4.aarch64 ;; "-q runc") echo runc-1.3.5-1.amzn2023.0.2.aarch64 ;; *) exit 2 ;; esac'
make_mock systemctl 'printf "systemctl %s\\n" "$*" >>"$SPROUT_TEST_CALL_LOG"'
make_mock dockerd \
  'printf "dockerd %s\\n" "$*" >>"$SPROUT_TEST_CALL_LOG"' \
  '[[ "$1" == --validate && "$2" == --config-file ]]' \
  'grep -Fq '"'"'"seccomp-profile": "/etc/docker/sproutos-seccomp.json"'"'"' "$3"'
make_mock docker \
  'printf "docker %s\\n" "$*" >>"$SPROUT_TEST_CALL_LOG"' \
  'printf '"'"'["name=seccomp,profile=/etc/docker/sproutos-seccomp.json","name=cgroupns"]\\n'"'"''
make_mock iptables \
  'printf "iptables %s\\n" "$*" >>"$SPROUT_TEST_CALL_LOG"' \
  'if [[ " $* " == *" -C "* ]] && [[ ! -e "$SPROUT_TEST_IMDS_RULE" ]]; then exit 1; fi' \
  'if [[ " $* " == *" -I "* ]]; then : >"$SPROUT_TEST_IMDS_RULE"; fi'

profile="$REPO_ROOT/tofu/ecs-seccomp-profile.json"
PATH="$mock_bin:$PATH" \
SPROUT_TEST_CALL_LOG="$call_log" \
SPROUT_TEST_IMDS_RULE="$test_root/imds-rule" \
SPROUT_HOST_ROOT="$test_root" \
SPROUT_IPTABLES_BIN="$mock_bin/iptables" \
SPROUT_ECS_CLUSTER=sproutos \
SPROUT_SECCOMP_PROFILE_B64="$(base64 <"$profile" | tr -d '\n')" \
SPROUT_SECCOMP_PROFILE_SHA256="$(sha256sum "$profile" | cut -d' ' -f1)" \
SPROUT_DOCKER_RPM=docker-25.0.16-1.amzn2023.0.4.aarch64 \
SPROUT_RUNC_RPM=runc-1.3.5-1.amzn2023.0.2.aarch64 \
bash "$SCRIPT_DIR/ecs-host-bootstrap.sh"

cmp --silent "$profile" "$test_root/etc/docker/sproutos-seccomp.json"
if [[ -z "$(find "$test_root/etc/docker/sproutos-seccomp.json" -prune -perm 0444 -print)" ]]; then
  fail 'installed seccomp profile is not mode 0444'
fi
grep -Fxq 'ECS_CLUSTER=sproutos' "$test_root/etc/ecs/ecs.config"
grep -Fxq 'ECS_DISABLE_PRIVILEGED=true' "$test_root/etc/ecs/ecs.config"
grep -Fq 'ExecStartPost=/usr/local/sbin/sproutos-block-container-imds' \
  "$test_root/etc/systemd/system/docker.service.d/20-sproutos-block-container-imds.conf"
grep -Fq '169.254.169.254/32' "$test_root/usr/local/sbin/sproutos-block-container-imds"
assert_equal "$(sed -n '1p' "$call_log")" 'systemctl stop ecs' 'bootstrap did not stop ECS first'
grep -Fxq 'systemctl daemon-reload' "$call_log"
grep -Fxq 'systemctl restart docker' "$call_log"
if ! grep -Fq 'iptables -w 10 -I DOCKER-USER 1 -i docker+ -d 169.254.169.254/32 -j DROP' "$call_log"; then
  fail "bootstrap did not install the container IMDS block: $(tr '\n' ';' <"$call_log")"
fi
assert_equal "$(tail -1 "$call_log")" 'systemctl restart ecs' 'bootstrap did not restart ECS last'

# Version drift fails before service mutation.
: >"$call_log"
make_mock rpm \
  'case "$*" in "-q docker") echo docker-26.0.0-1.amzn2023.aarch64 ;; "-q runc") echo runc-1.3.5-1.amzn2023.0.2.aarch64 ;; *) exit 2 ;; esac'
if PATH="$mock_bin:$PATH" \
  SPROUT_TEST_CALL_LOG="$call_log" \
  SPROUT_TEST_IMDS_RULE="$test_root/imds-rule" \
  SPROUT_HOST_ROOT="$test_root" \
  SPROUT_IPTABLES_BIN="$mock_bin/iptables" \
  SPROUT_ECS_CLUSTER=sproutos \
  SPROUT_SECCOMP_PROFILE_B64="$(base64 <"$profile" | tr -d '\n')" \
  SPROUT_SECCOMP_PROFILE_SHA256="$(sha256sum "$profile" | cut -d' ' -f1)" \
  SPROUT_DOCKER_RPM=docker-25.0.16-1.amzn2023.0.4.aarch64 \
  SPROUT_RUNC_RPM=runc-1.3.5-1.amzn2023.0.2.aarch64 \
  bash "$SCRIPT_DIR/ecs-host-bootstrap.sh" 2>/dev/null; then
  echo 'bootstrap accepted an unreviewed Docker version' >&2
  exit 1
fi
if [[ -s "$call_log" ]]; then
  fail 'version drift mutated services before failing'
fi

# An unmanaged daemon config is never overwritten.
make_mock rpm \
  'case "$*" in "-q docker") echo docker-25.0.16-1.amzn2023.0.4.aarch64 ;; "-q runc") echo runc-1.3.5-1.amzn2023.0.2.aarch64 ;; *) exit 2 ;; esac'
chmod u+w "$test_root/etc/docker/daemon.json"
printf '{"log-driver":"journald"}\n' >"$test_root/etc/docker/daemon.json"
: >"$call_log"
if PATH="$mock_bin:$PATH" \
  SPROUT_TEST_CALL_LOG="$call_log" \
  SPROUT_TEST_IMDS_RULE="$test_root/imds-rule" \
  SPROUT_HOST_ROOT="$test_root" \
  SPROUT_IPTABLES_BIN="$mock_bin/iptables" \
  SPROUT_ECS_CLUSTER=sproutos \
  SPROUT_SECCOMP_PROFILE_B64="$(base64 <"$profile" | tr -d '\n')" \
  SPROUT_SECCOMP_PROFILE_SHA256="$(sha256sum "$profile" | cut -d' ' -f1)" \
  SPROUT_DOCKER_RPM=docker-25.0.16-1.amzn2023.0.4.aarch64 \
  SPROUT_RUNC_RPM=runc-1.3.5-1.amzn2023.0.2.aarch64 \
  bash "$SCRIPT_DIR/ecs-host-bootstrap.sh" 2>/dev/null; then
  echo 'bootstrap overwrote unmanaged daemon configuration' >&2
  exit 1
fi
if [[ -s "$call_log" ]]; then
  fail 'unmanaged daemon configuration mutated services before failing'
fi

echo 'ECS host seccomp bootstrap is pinned, validated, and fail closed'
