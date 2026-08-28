#!/usr/bin/env bash
set -euo pipefail

: "${SPROUT_ECS_CLUSTER:?SPROUT_ECS_CLUSTER is required}"
: "${SPROUT_SECCOMP_PROFILE_B64:?SPROUT_SECCOMP_PROFILE_B64 is required}"
: "${SPROUT_SECCOMP_PROFILE_SHA256:?SPROUT_SECCOMP_PROFILE_SHA256 is required}"
: "${SPROUT_DOCKER_RPM:?SPROUT_DOCKER_RPM is required}"
: "${SPROUT_RUNC_RPM:?SPROUT_RUNC_RPM is required}"

host_root="${SPROUT_HOST_ROOT:-}"
docker_dir="${host_root}/etc/docker"
profile_path="${docker_dir}/sproutos-seccomp.json"
daemon_path="${docker_dir}/daemon.json"
ecs_config="${host_root}/etc/ecs/ecs.config"
profile_tmp="$(mktemp)"
daemon_tmp="$(mktemp)"
ecs_tmp="$(mktemp)"
cleanup() {
  unlink "$profile_tmp" "$daemon_tmp" "$ecs_tmp" 2>/dev/null || true
}
trap cleanup EXIT

actual_docker="$(rpm -q docker)"
actual_runc="$(rpm -q runc)"
if [[ "$actual_docker" != "$SPROUT_DOCKER_RPM" ]]; then
  echo "unsupported Docker RPM: expected $SPROUT_DOCKER_RPM, found $actual_docker" >&2
  exit 1
fi
if [[ "$actual_runc" != "$SPROUT_RUNC_RPM" ]]; then
  echo "unsupported runc RPM: expected $SPROUT_RUNC_RPM, found $actual_runc" >&2
  exit 1
fi

printf '%s' "$SPROUT_SECCOMP_PROFILE_B64" | base64 --decode >"$profile_tmp"
actual_profile_sha256="$(sha256sum "$profile_tmp" | cut -d' ' -f1)"
if [[ "$actual_profile_sha256" != "$SPROUT_SECCOMP_PROFILE_SHA256" ]]; then
  echo "seccomp profile digest mismatch" >&2
  exit 1
fi
printf '{\n  "seccomp-profile": "/etc/docker/sproutos-seccomp.json"\n}\n' >"$daemon_tmp"

if [[ -e "$daemon_path" ]] && ! cmp --silent "$daemon_tmp" "$daemon_path"; then
  echo "$daemon_path contains unmanaged Docker settings; refusing to overwrite it" >&2
  exit 1
fi

# Stop scheduling before changing the daemon. Any later failure deliberately leaves ECS stopped.
systemctl stop ecs
install -d -m 0755 "$docker_dir" "$(dirname "$ecs_config")"
install -m 0444 "$profile_tmp" "$profile_path"
install -m 0444 "$daemon_tmp" "$daemon_path"
dockerd --validate --config-file "$daemon_path"
systemctl restart docker

security_options="$(docker info --format '{{json .SecurityOptions}}')"
if [[ "$security_options" != *'name=seccomp,profile=/etc/docker/sproutos-seccomp.json'* ]]; then
  echo "Docker did not activate the SproutOS seccomp profile: $security_options" >&2
  exit 1
fi

if [[ -e "$ecs_config" ]]; then
  grep -Ev '^(ECS_CLUSTER|ECS_ENABLE_CONTAINER_METADATA|ECS_DISABLE_PRIVILEGED)=' \
    "$ecs_config" >"$ecs_tmp"
fi
printf 'ECS_CLUSTER=%s\n' "$SPROUT_ECS_CLUSTER" >>"$ecs_tmp"
printf 'ECS_ENABLE_CONTAINER_METADATA=true\n' >>"$ecs_tmp"
printf 'ECS_DISABLE_PRIVILEGED=true\n' >>"$ecs_tmp"
install -m 0600 "$ecs_tmp" "$ecs_config"
systemctl restart ecs
