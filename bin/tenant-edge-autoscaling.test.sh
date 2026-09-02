#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
COMPUTE="$ROOT/tofu/compute.tf"
VARIABLES="$ROOT/tofu/variables.tf"

require() {
  local needle=$1 file=$2
  if ! grep -Fq "$needle" "$file"; then
    echo "missing tenant-edge autoscaling contract: $needle" >&2
    exit 1
  fi
}

require 'metric_name = "ActiveFlowCount"' "$COMPUTE"
require 'metric_name = "HealthyHostCount"' "$COMPUTE"
require 'expression  = "flows / IF(healthy > 0, healthy, 1)"' "$COMPUTE"
require 'id          = "flows_per_target"' "$COMPUTE"
require 'target_value     = var.tenant_edge_active_flows_per_target' "$COMPUTE"
require 'variable "tenant_edge_active_flows_per_target"' "$VARIABLES"
require 'default     = 1000' "$VARIABLES"
require 'variable "service_desired_count"' "$VARIABLES"
require 'variable "service_max_count"' "$VARIABLES"

if [ "$(awk '/variable "service_desired_count"/{seen=1} seen && /default/{print $3; exit}' "$VARIABLES")" != "1" ]; then
  echo "the normal service capacity must be one instance" >&2
  exit 1
fi

if [ "$(awk '/variable "service_max_count"/{seen=1} seen && /default/{print $3; exit}' "$VARIABLES")" != "2" ]; then
  echo "the per-colour service hard cap must be two instances" >&2
  exit 1
fi

require 'DESIRED="${DESIRED:-1}"' "$ROOT/bin/fill-idle.sh"
require "DESIRED: \${{ vars.SERVICE_DESIRED_COUNT || '1' }}" "$ROOT/.github/workflows/deploy.yml"

if grep -Fq 'metric_name = "NewFlowCount"' "$COMPUTE"; then
  echo "aggregate NewFlowCount must not drive a per-router target-tracking policy" >&2
  exit 1
fi

echo "tenant-edge autoscaling metric is normalized by healthy serving routers"
