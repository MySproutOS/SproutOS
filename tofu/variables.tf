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

/*
  Where tenant applications are served from.

  Separate from `control_plane_domain` on purpose, per ADR 0018. Everything — the control plane,
  the API, the forum, and every customer site — currently shares one apex, which means a customer
  hostname and our own sign-in page are one wildcard apart. A tenant domain of its own is the
  boundary: cookies scoped to the control plane cannot be read from a tenant site, and a tenant
  certificate cannot vouch for `api.<control plane>`.

  ADR 0018 writes this as `sprout.run`. The domain actually registered is **`sproutos.run`**, and
  the ADR is amended rather than the code made to match a domain nobody owns.
*/
variable "tenant_domain" {
  description = "Domain tenant applications are served from"
  type        = string
  default     = "sproutos.run"
}

variable "acme_directory_url" {
  description = "ACME directory used by the Rust tenant edge. Keep staging until the complete edge smoke passes, then set the Let's Encrypt production directory explicitly."
  type        = string
  default     = "https://acme-staging-v02.api.letsencrypt.org/directory"

  validation {
    condition     = startswith(var.acme_directory_url, "https://")
    error_message = "The ACME directory must be an HTTPS URL."
  }
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
  description = "PostgreSQL engine version for the control plane. RDS, not Aurora — see database.tf."
  type        = string
  # 18 to match the compose Postgres, so a migration that applies locally applies here.
  #
  # 17.4 was an *Aurora* version and does not exist on RDS — the API answers "Cannot find version
  # 17.4 for postgres". Every version here is checked against
  # `describe-orderable-db-instance-options` for the chosen instance class rather than assumed.
  default = "18.6"
}

# Aurora Capacity Units. 0.5 is the floor that keeps the cluster warm; the first connection after a
# pause waits for a resume, and the thing connecting is the API serving somebody's dashboard.
variable "database_instance_class" {
  description = "RDS instance class. db.t4g.micro is in the free tier for the first year and a few dollars a month after."
  type        = string
  default     = "db.t4g.micro"
}

variable "database_storage_gb" {
  description = "Allocated storage. 20 GB is the free-tier allowance."
  type        = number
  default     = 20
}

variable "database_max_storage_gb" {
  description = "Ceiling for storage autoscaling. What stops a runaway query turning a disk into a bill."
  type        = number
  default     = 100
}

variable "database_multi_az" {
  description = "A standby in a second AZ. Doubles the instance cost and turns an AZ failure from a restore into a failover."
  type        = bool
  default     = false
}

variable "deletion_protection" {
  description = "Refuse to delete the control-plane database. Off only for a throwaway environment."
  type        = bool
  default     = true
}

variable "service_instance_type" {
  description = "EC2 type for the website and router. t4g.micro is in the free tier for the first year (750 hours/month, which covers one instance continuously). Graviton because the router is a static Rust binary and the website is Node, both of which build for arm64."
  type        = string
  default     = "t4g.micro"
}

variable "service_desired_count" {
  description = "Instances in the live colour of each service."
  type        = number
  default     = 2
}

variable "tenant_edge_active_flows_per_target" {
  description = "Concurrent NLB TCP flows per healthy serving router before scaling out."
  type        = number
  default     = 100

  validation {
    condition     = var.tenant_edge_active_flows_per_target > 0
    error_message = "The tenant edge flow target must be positive."
  }
}

variable "tenant_edge_enabled" {
  description = "Move public 80/443 and generated tenant DNS to the Rust edge after its production certificate and smoke checks pass."
  type        = bool
  default     = false
}

variable "tenant_edge_preview_enabled" {
  description = "Provision the parallel Rust edge NLB on public 80/443 and its preview ingress name without moving production tenant DNS."
  type        = bool
  default     = false
}

variable "acme_worker_enabled" {
  description = "Run the IAM-isolated certificate/deployment worker after the smaller web task is live. Keep false for the first infrastructure apply so the old 768 MiB web task retains the spare rollout host."
  type        = bool
  default     = false

  validation {
    condition = var.acme_worker_enabled || !(
      var.tenant_edge_preview_enabled || var.tenant_edge_enabled || var.custom_domain_issuance_enabled
    )
    error_message = "The isolated ACME worker must be enabled before preview edge, tenant edge, or custom-domain issuance."
  }
}

variable "custom_domain_issuance_enabled" {
  description = "Allow custom-domain claims and asynchronous ACME work independently of the generated-traffic DNS cutover. Enable first against staging on the preview edge."
  type        = bool
  default     = false

  validation {
    condition     = !var.custom_domain_issuance_enabled || var.tenant_edge_preview_enabled || var.tenant_edge_enabled
    error_message = "Custom-domain issuance requires either the preview edge or the production tenant edge."
  }
}

variable "tenant_edge_preview_colour" {
  description = "Router colour explicitly filled with the edge-capable release for isolated preview traffic."
  type        = string
  default     = "blue"

  validation {
    condition     = contains(["blue", "green"], var.tenant_edge_preview_colour)
    error_message = "The tenant edge preview colour must be blue or green."
  }
}

variable "service_max_count" {
  description = "Ceiling per Auto Scaling group."
  type        = number
  default     = 6
}

variable "cache_node_type" {
  description = "ElastiCache node for the platform Valkey. cache.t4g.micro is the smallest and is in the free tier for the first year. It holds a route map and some counters."
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

variable "use_nat_instance" {
  description = "Egress through an fck-nat instance (~$3/month, one AZ, one instance) instead of a managed NAT gateway ($33/month plus $0.045/GB). See nat.tf for what is given up."
  type        = bool
  default     = true
}

variable "nat_instance_type" {
  description = "The NAT instance. t4g.nano is ~$3/month and does several Gbps burst; it is credit-limited on sustained traffic."
  type        = string
  default     = "t4g.nano"
}

/*
  The OVH host, by address, because DNS has to name one.

  Everything else in this estate is reached through an alias to something AWS names for us. The
  forum is not ours to alias — it is a dedicated site on the box that also carries ClickHouse,
  Kafka, tenant Valkey and OpenSearch — so these are the literal addresses `ovh/README.md` records,
  and they are the one place in `tofu/` that has to change if the box moves.
*/
variable "ovh_host_ipv4" {
  description = "The OVH dedicated host's IPv4 address."
  type        = string
  default     = "135.148.122.203"
}

variable "ovh_host_ipv6" {
  description = "The OVH dedicated host's IPv6 address. OVH assigns a /64; this is the address configured on eno1."
  type        = string
  default     = "2604:2dc0:100:3bcb::"
}

variable "forum_subdomain" {
  description = "The label under control_plane_domain that resolves to the OVH host rather than the ALB."
  type        = string
  default     = "forum"
}

variable "kafka_subdomain" {
  description = "The label the log extension connects to. Resolves to the OVH host, and is the name on its TLS certificate."
  type        = string
  default     = "kafka"
}

/*
  The same repository, spelled the way GitHub's OIDC token spells it.

  GitHub can issue a `sub` claim qualified by numeric owner and repository *ids* rather than names:

      repo:MySproutOS@319999162/SproutOS@1340349949:ref:refs/heads/main

  rather than `repo:MySproutOS/SproutOS:ref:refs/heads/main`. It exists so a trust policy survives a
  rename — names are reusable, ids are not — and it is set per organization, so which form arrives
  is not visible from anything in this repository. `gh api /repos/<owner>/<repo>/actions/oidc/customization/sub`
  reports it as `sub_claim_prefix`.

  A policy written for the name form is not *wrong* anywhere it can be read; it simply never
  matches, and the failure is `Not authorized to perform sts:AssumeRoleWithWebIdentity` with nothing
  naming the claim that missed.

  Both forms are trusted below, spelled out in full. A wildcard on the organization name would be
  shorter and worse: it would also match an organization someone else can create whose name merely
  starts with ours.

  (And a literal wildcard-then-slash cannot be written in this comment at all — it ends it. Which is
  its own small argument for not reaching for one.)
*/
variable "github_repo_ids" {
  description = "The id-qualified form of github_repo, from the sub_claim_prefix. Empty to trust only the name form."
  type        = string
  default     = "MySproutOS@319999162/SproutOS@1340349949"
}

variable "node_version" {
  description = "Node for the website instances. Must match .config/mise.toml and the deploy workflow."
  type        = string
  default     = "24.14.0"
}

variable "environment" {
  description = "Which deployment this is. Some resources exist only in production — see forum-static.tf."
  type        = string
  default     = "production"

  validation {
    condition     = contains(["production", "staging"], var.environment)
    error_message = "environment must be production or staging."
  }
}

variable "forum_repo" {
  description = "The repository that publishes the forum's static assets."
  type        = string
  default     = "SproutOS-Agent/SproutOS-Agent-Forum"
}

variable "forum_repo_ids" {
  description = "The id-qualified form of forum_repo. See github_repo_ids for why both are trusted."
  type        = string
  default     = "SproutOS-Agent@320371408/SproutOS-Agent-Forum@1345557757"
}

variable "web_image" {
  description = "The image the website, API and worker all run. Published to GHCR by the deploy workflow."
  type        = string
  default     = "ghcr.io/mysproutos/sproutos-web:main"
}

variable "ecs_instance_count" {
  description = "Steady-state instances backing ECS. Deployments may briefly add one instance so the old task stays healthy until its replacement is ready."
  type        = number
  default     = 1
}

variable "clickhouse_subdomain" {
  description = "Where the API reaches ClickHouse. Resolves to the OVH host, behind its Traefik."
  type        = string
  default     = "clickhouse"
}

variable "opensearch_subdomain" {
  description = "Where the router's search split reaches OpenSearch. Resolves to the OVH host, behind its Traefik."
  type        = string
  default     = "opensearch"
}

variable "tenant_valkey_subdomain" {
  description = "The customer-facing address of the Valkey split, in front of `valkey-proxy`. Never the queue itself."
  type        = string
  default     = "valkey"
}

variable "tenant_queue_subdomain" {
  description = "Where the router's Valkey split reaches the tenant queue on the OVH host. Valkey terminates its own TLS there."
  type        = string
  default     = "queue"
}

variable "search_subdomain" {
  description = "The customer-facing address of the search split, in front of `search-proxy`. Never the cluster itself."
  type        = string
  default     = "search"
}

variable "storage_subdomain" {
  description = "The customer-facing address of storage-proxy. Never the physical S3 bucket."
  type        = string
  default     = "storage"
}

variable "storage_proxy_enabled" {
  description = <<-EOT
    Rollout interlock for the storage-proxy target groups. Leave false while the launch-template
    environment and storage-proxy binary are being deployed. Set true only after the binary is
    healthy on the serving router release, then run bin/enable-storage-proxy.sh to require healthy
    attached targets and reconcile the staged rule with the currently serving router colour. An
    ELB-health-checked Auto Scaling group replaces an instance when any attached target group is
    unhealthy, so attaching port 9000 to an old release can recycle the whole live router fleet.
  EOT
  type        = bool
  default     = false
}

variable "llm_subdomain" {
  description = "Where the router's LLM proxy answers. A sandbox reaches it from outside the VPC, so it is public, and a proxy token is the only thing that gets past it."
  type        = string
  default     = "llm"
}

variable "postgres_subdomain" {
  description = "The customer-facing address of the Postgres split, in front of `pg-proxy`. Never a Neon host."
  type        = string
  default     = "postgres"
}

variable "egress_subdomain" {
  description = "The customer-facing HTTPS address of the authenticated sandbox forward proxy."
  type        = string
  default     = "egress"
}

/*
  Which version of AWS's Lambda Web Adapter layer customer functions are published with.

  The adapter is what lets an ordinary HTTP server — a Next.js standalone build, a Hono `dist` —
  run on Lambda without the customer writing a Lambda handler. See
  `lib/typescript/lambda/src/web-adapter.ts` for why that is the shape rather than requiring an
  exported handler.

  A number, not an ARN: the layer is published by AWS's own account (753240598075) into every
  region, and the ARN is composed from this and the region. Pinned deliberately — this is the
  adapter's code, and "latest" would move every function published after a bump.

  29 is `1.1.0`, the newest version AWS shares publicly at the time of writing.
*/
variable "lambda_web_adapter_layer_version" {
  description = "AWS Lambda Web Adapter layer version customer web-server builds are published with."
  type        = string
  default     = "29"
}
