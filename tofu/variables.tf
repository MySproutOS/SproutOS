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
