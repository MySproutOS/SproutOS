#!/usr/bin/env bash
# Render the exact decoded aws_launch_template.ecs user-data source for review-time comparison.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: render-ecs-launch-template-user-data.sh <ecs-cluster-name>" >&2
  exit 2
fi
HERE=$(cd "$(dirname "$0")" && pwd)
TOFU_DIR="${TOFU_DIR:-$HERE/../tofu}"
cluster=$1
bootstrap_b64=$(base64 <"$TOFU_DIR/ecs-host-bootstrap.sh" | tr -d '\n')
bootstrap_sha=$(shasum -a 256 "$TOFU_DIR/ecs-host-bootstrap.sh" | awk '{print $1}')
profile_b64=$(base64 <"$TOFU_DIR/ecs-seccomp-profile.json" | tr -d '\n')
profile_sha=$(shasum -a 256 "$TOFU_DIR/ecs-seccomp-profile.json" | awk '{print $1}')

printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'install -d -m 0755 /usr/local/sbin' \
  "printf '%s' '$bootstrap_b64' \\" \
  '  | base64 --decode >/usr/local/sbin/sproutos-ecs-bootstrap' \
  "printf '%s  %s\\n' \\" \
  "  '$bootstrap_sha' \\" \
  '  /usr/local/sbin/sproutos-ecs-bootstrap \' \
  '  | sha256sum --check --status' \
  'chmod 0555 /usr/local/sbin/sproutos-ecs-bootstrap' \
  "SPROUT_ECS_CLUSTER='$cluster' \\" \
  "SPROUT_SECCOMP_PROFILE_B64='$profile_b64' \\" \
  "SPROUT_SECCOMP_PROFILE_SHA256='$profile_sha' \\" \
  "SPROUT_DOCKER_RPM='docker-25.0.16-1.amzn2023.0.4.aarch64' \\" \
  "SPROUT_RUNC_RPM='runc-1.3.5-1.amzn2023.0.2.aarch64' \\" \
  '  /usr/local/sbin/sproutos-ecs-bootstrap'
