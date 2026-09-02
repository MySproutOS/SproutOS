#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
image="sproutos-bwrap-seccomp-probe:$$"
cleanup() {
  docker image rm --force "$image" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker build --quiet --tag "$image" - <<'DOCKERFILE' >/dev/null
FROM node:24.14.0-slim
RUN apt-get update \
    && apt-get install --yes --no-install-recommends bubblewrap=0.8.0-2+deb12u1 \
    && rm -rf /var/lib/apt/lists/* \
    && test "$(bwrap --version)" = "bubblewrap 0.8.0"
USER node
DOCKERFILE

docker run --rm \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --security-opt apparmor=unconfined \
  --security-opt "seccomp=${script_dir}/ecs-seccomp-profile.json" \
  "$image" \
  bwrap \
    --die-with-parent \
    --new-session \
    --unshare-all \
    --share-net \
    --unshare-user \
    --unshare-pid \
    --cap-drop ALL \
    --clearenv \
    --tmpfs / \
    --ro-bind /usr /usr \
    --ro-bind /lib /lib \
    --chdir / \
    -- /usr/bin/true

echo 'ECS outer seccomp admits the exact non-network Bubblewrap namespace boundary'
