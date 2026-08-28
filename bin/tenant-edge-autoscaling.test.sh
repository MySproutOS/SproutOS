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

if grep -Fq 'metric_name = "NewFlowCount"' "$COMPUTE"; then
  echo "aggregate NewFlowCount must not drive a per-router target-tracking policy" >&2
  exit 1
fi

echo "tenant-edge autoscaling metric is normalized by healthy serving routers"
