# A default here was the upstream template author's account, `471112590391`, inherited when this
# repo was copied from `nextjs-spa-split`. A variable whose whole job is to assert "we are applying
# into the right account" must not default to somebody else's — a wrong value that is present is
# worse than one that is absent, because the guard passes.
#
# No default, so `tofu plan` refuses until it is set.
variable "aws_account_id" {
  description = "AWS account ID to validate against. Required — there is no safe default."
  type        = string
}

variable "github_repo" {
  description = "GitHub repository in owner/repo format"
  type        = string
  default     = "Andrew-Chen-Wang/SproutOS"
}

variable "s3_bucket_name" {
  description = "Name of the S3 bucket for SPA assets"
  type        = string
  default     = "sproutos-spa-assets"
}

# ADR 0018: `sproutos.dev` is the control plane, `sprout.run` is tenant and preview traffic.
# Preview hosts are single-label (`pr-42--myapp.sprout.run`) because an ACM wildcard covers
# exactly one label.
variable "control_plane_domain" {
  description = "Domain the website and dashboard are served from"
  type        = string
  default     = "sproutos.dev"
}

variable "aws_region" {
  description = "Region everything is deployed into"
  type        = string
  default     = "us-east-1"
}

# Prefixes every resource name. A second environment is a second workspace with a different value
# here, not a second copy of this directory.
variable "name_prefix" {
  description = "Name prefix for every resource"
  type        = string
  default     = "sproutos"
}

variable "vpc_cidr" {
  description = "IPv4 CIDR for the VPC. /16, so subnets can be added without renumbering."
  type        = string
  default     = "10.42.0.0/16"

  validation {
    condition     = tonumber(split("/", var.vpc_cidr)[1]) <= 16
    error_message = "The VPC needs at least a /16: twelve /20 subnets are carved out of it, and growing the range later means recreating the VPC and the cluster inside it."
  }
}

variable "kubernetes_version" {
  description = "EKS control plane version"
  type        = string
  default     = "1.34"
}

# arm64 everywhere. `m8g` is Graviton4 general purpose; the platform's own workloads are not
# memory-bound, and one architecture means one build of every image.
variable "platform_instance_types" {
  description = "Instance types for the platform node group"
  type        = list(string)
  default     = ["m8g.large", "m8g.xlarge"]
}

variable "platform_node_count" {
  description = "Desired platform nodes. Autoscaled after creation; this is only the starting point."
  type        = number
  default     = 3
}

/*
  Bare metal for tenant workloads.

  Kata needs a hypervisor, and a hypervisor needs hardware virtualisation the nested case does not
  expose. `m8g.metal-24xl` is the smallest Graviton4 metal instance — and "smallest" is doing real
  work in that sentence, because this is where the money goes.
*/
variable "tenant_instance_type" {
  description = "Bare-metal instance type for tenant workloads under Kata"
  type        = string
  default     = "m8g.metal-24xl"
}

variable "tenant_node_count" {
  description = "Fixed tenant metal nodes. Not autoscaled: metal takes 10-20 minutes to boot, which is unusable as a just-in-time scaling unit."
  type        = number
  default     = 2
}

variable "postgres_version" {
  description = "Aurora PostgreSQL engine version for the control plane"
  type        = string
  default     = "17.4"
}

# Aurora Capacity Units. 0.5 is the floor that keeps the cluster warm; the first connection after a
# pause waits for a resume, and the thing connecting is the API serving somebody's dashboard.
variable "database_min_acu" {
  description = "Minimum Aurora Serverless v2 capacity"
  type        = number
  default     = 0.5
}

variable "database_max_acu" {
  description = "Maximum Aurora Serverless v2 capacity"
  type        = number
  default     = 16
}

variable "cluster_public_access_cidrs" {
  description = "Who may reach the public Kubernetes API endpoint. Narrow this; the default is everywhere."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "deletion_protection" {
  description = "Refuse to delete the control-plane database. Off only for a throwaway environment."
  type        = bool
  default     = true
}
