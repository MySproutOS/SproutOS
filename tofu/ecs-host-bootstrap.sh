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
imds_script="${host_root}/usr/local/sbin/sproutos-block-container-imds"
docker_dropin_dir="${host_root}/etc/systemd/system/docker.service.d"
docker_dropin="${docker_dropin_dir}/20-sproutos-block-container-imds.conf"
iptables_bin="${SPROUT_IPTABLES_BIN:-/usr/sbin/iptables}"
profile_tmp="$(mktemp)"
daemon_tmp="$(mktemp)"
ecs_tmp="$(mktemp)"
imds_tmp="$(mktemp)"
dropin_tmp="$(mktemp)"
cleanup() {
  unlink "$profile_tmp" "$daemon_tmp" "$ecs_tmp" "$imds_tmp" "$dropin_tmp" 2>/dev/null || true
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
cat >"$imds_tmp" <<'IMDS_SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
if ! /usr/sbin/iptables -w 10 -C DOCKER-USER -i docker+ -d 169.254.169.254/32 -j DROP; then
  /usr/sbin/iptables -w 10 -I DOCKER-USER 1 -i docker+ -d 169.254.169.254/32 -j DROP
fi
IMDS_SCRIPT
cat >"$dropin_tmp" <<'IMDS_UNIT'
[Service]
ExecStartPost=/usr/local/sbin/sproutos-block-container-imds
IMDS_UNIT

if [[ -e "$daemon_path" ]] && ! cmp --silent "$daemon_tmp" "$daemon_path"; then
  echo "$daemon_path contains unmanaged Docker settings; refusing to overwrite it" >&2
  exit 1
fi

# Stop scheduling before changing the daemon. Any later failure deliberately leaves ECS stopped.
systemctl stop ecs
install -d -m 0755 \
  "$docker_dir" \
  "$(dirname "$ecs_config")" \
  "$(dirname "$imds_script")" \
  "$docker_dropin_dir"
install -m 0444 "$profile_tmp" "$profile_path"
install -m 0444 "$daemon_tmp" "$daemon_path"
install -m 0555 "$imds_tmp" "$imds_script"
install -m 0444 "$dropin_tmp" "$docker_dropin"
dockerd --validate --config-file "$daemon_path"
systemctl daemon-reload
systemctl restart docker

# Bridge-networked tasks can otherwise reach the host instance role. The drop-in restores this
# rule after every Docker restart; the direct assertion prevents ECS from starting if it is absent.
if ! "$iptables_bin" -w 10 -C DOCKER-USER -i docker+ -d 169.254.169.254/32 -j DROP; then
  "$iptables_bin" -w 10 -I DOCKER-USER 1 -i docker+ -d 169.254.169.254/32 -j DROP
fi
"$iptables_bin" -w 10 -C DOCKER-USER -i docker+ -d 169.254.169.254/32 -j DROP

security_options="$(docker info --format '{{json .SecurityOptions}}')"
if [[ "$security_options" != *'name=seccomp,profile=/etc/docker/sproutos-seccomp.json'* ]]; then
  echo "Docker did not activate the SproutOS seccomp profile: $security_options" >&2
  exit 1
fi

if [[ -e "$ecs_config" ]]; then
  awk '!/^(ECS_CLUSTER|ECS_ENABLE_CONTAINER_METADATA|ECS_DISABLE_PRIVILEGED)=/' \
    "$ecs_config" >"$ecs_tmp"
fi
printf 'ECS_CLUSTER=%s\n' "$SPROUT_ECS_CLUSTER" >>"$ecs_tmp"
printf 'ECS_ENABLE_CONTAINER_METADATA=true\n' >>"$ecs_tmp"
printf 'ECS_DISABLE_PRIVILEGED=true\n' >>"$ecs_tmp"
install -m 0600 "$ecs_tmp" "$ecs_config"
systemctl restart ecs
