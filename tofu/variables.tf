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

# arm64 everywhere. `m8g` is Graviton4 general purpose; the platform's own workloads are not
# memory-bound, and one architecture means one build of every image.
/*
  Bare metal for tenant workloads.

  Kata needs a hypervisor, and a hypervisor needs hardware virtualisation the nested case does not
  expose. `m8g.metal-24xl` is the smallest Graviton4 metal instance — and "smallest" is doing real
  work in that sentence, because this is where the money goes.
*/
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

variable "deletion_protection" {
  description = "Refuse to delete the control-plane database. Off only for a throwaway environment."
  type        = bool
  default     = true
}

variable "tenant_bucket_prefix" {
  description = <<-EOT
    The prefix every tenant object-storage bucket carries.

    `bucketNameFor` in `lib/typescript/services` produces `v-<short-id>`, and the IAM policies in
    `storage.tf` are scoped to this prefix. Changing it in one place and not the other does not fail
    a plan — it produces a platform that provisions buckets the proxy is not allowed to read.
  EOT
  type        = string
  default     = "v-"
}

variable "service_instance_type" {
  description = "EC2 type for the website and router instances. Graviton: the router is a static Rust binary and the website is Node, both of which build for arm64."
  type        = string
  default     = "t4g.small"
}

variable "service_desired_count" {
  description = "Instances in the live colour of each service."
  type        = number
  default     = 2
}

variable "service_max_count" {
  description = "Ceiling per Auto Scaling group."
  type        = number
  default     = 6
}

variable "cache_node_type" {
  description = "ElastiCache node for the platform Valkey. The smallest: a route map and some counters."
  type        = string
  default     = "cache.t4g.micro"
}

variable "valkey_version" {
  description = "ElastiCache Valkey engine version."
  type        = string
  default     = "8.0"
}

variable "valkey_parameter_family" {
  description = "Parameter group family matching valkey_version."
  type        = string
  default     = "valkey8"
}

variable "requests_per_target" {
  description = "Requests per minute per instance the scaling policy aims for. A starting guess; the number to trust is the one measured under real traffic."
  type        = number
  default     = 1000
}
