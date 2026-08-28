#!/usr/bin/env bash
set -euo pipefail

HERE=$(cd "$(dirname "$0")/.." && pwd)
ECS="$HERE/tofu/ecs.tf"
VARIABLES="$HERE/tofu/variables.tf"
WORKFLOW="$HERE/.github/workflows/deploy.yml"

# The steady state and release path must agree. A repository variable must not be able to turn a
# successful workflow run into a silent one-replica regression.
grep -A12 'variable "ecs_instance_count"' "$VARIABLES" | grep -q 'default     = 2'
grep -A12 'variable "ecs_instance_count"' "$VARIABLES" | grep -q 'var.ecs_instance_count == 2'
grep -q 'ECS_WEB_DESIRED_COUNT: "2"' "$WORKFLOW"

# Two fixed-port replicas need one additional host and one additional task, not two replacements at
# once. The hard constraint and first spread strategy make the failure domains explicit.
grep -A80 'resource "aws_ecs_service" "web"' "$ECS" | grep -q 'deployment_maximum_percent         = 150'
grep -A80 'resource "aws_ecs_service" "web"' "$ECS" | grep -q 'deployment_minimum_healthy_percent = 100'
grep -A80 'resource "aws_ecs_service" "web"' "$ECS" | grep -q 'field = "attribute:ecs.availability-zone"'
grep -A80 'resource "aws_ecs_service" "web"' "$ECS" | grep -q 'availability_zone_rebalancing = "ENABLED"'
grep -A80 'resource "aws_ecs_service" "web"' "$ECS" | grep -q 'type = "distinctInstance"'
grep -A20 'resource "aws_autoscaling_group" "ecs"' "$ECS" | grep -q 'max_size         = var.ecs_instance_count + 1'
grep -A20 'resource "aws_autoscaling_group" "ecs"' "$ECS" | grep -q 'enabled_metrics     = \["GroupInServiceInstances"\]'

# OpenTofu owns desired-count drift, and customer-visible health plus host capacity are all alarmed
# without enabling paid Container Insights.
grep -A180 'resource "aws_ecs_service" "web"' "$ECS" | grep -q 'ignore_changes = \[task_definition\]'
grep -q 'resource "aws_cloudwatch_metric_alarm" "ecs_healthy_targets"' "$ECS"
grep -q 'resource "aws_cloudwatch_metric_alarm" "ecs_unhealthy_targets"' "$ECS"
grep -q 'resource "aws_cloudwatch_metric_alarm" "ecs_in_service_hosts"' "$ECS"
grep -A8 'resource "aws_ecs_cluster" "main"' "$ECS" | grep -q 'value = "disabled"'

# A task-definition-only correction must not pull the router launch templates and target groups
# into its dependency graph. The ASG names are deterministic; treating them as resource outputs
# couples otherwise independent production rollouts and makes a narrow saved plan impossible.
if grep -q 'PLATFORM_ROUTER_ASG_NAMES.*aws_autoscaling_group\.router' "$ECS"; then
  echo "ECS task definition must derive stable router ASG names without resource dependencies" >&2
  exit 1
fi

echo "ECS HA contract tests passed"
