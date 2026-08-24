output "bucket_name" {
  description = "Name of the S3 bucket"
  value       = aws_s3_bucket.spa.id
}

output "cloudfront_domain" {
  description = "CloudFront distribution domain name"
  value       = aws_cloudfront_distribution.spa.domain_name
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution ID"
  value       = aws_cloudfront_distribution.spa.id
}

output "role_arn" {
  description = "ARN of the IAM role for GitHub Actions"
  value       = aws_iam_role.github_actions_spa_deploy.arn
}

output "database_endpoint" {
  description = "Control-plane Postgres writer endpoint"
  value       = aws_rds_cluster.control_plane.endpoint
}

output "database_reader_endpoint" {
  description = "Control-plane Postgres reader endpoint"
  value       = aws_rds_cluster.control_plane.reader_endpoint
}

# The ARN, not the secret. The value is fetched at runtime by whatever holds the IAM permission to
# read it; putting it in an output writes it to state in the clear.
output "database_credentials_secret_arn" {
  description = "Secrets Manager ARN holding the control-plane database password"
  value       = aws_rds_cluster.control_plane.master_user_secret[0].secret_arn
}

output "envelope_kms_key_arn" {
  description = "KMS key `@lib/envelope` wraps data keys with. Set as KMS_KEY_ID."
  value       = aws_kms_key.envelope.arn
}

output "ecr_repository_urls" {
  description = "Registry URL per platform image"
  value       = { for name, repo in aws_ecr_repository.platform : name => repo.repository_url }
}

output "vpc_id" {
  description = "VPC everything is deployed into"
  value       = aws_vpc.main.id
}

# Read by `bin/render-manifests.mjs` to fill the `ACCOUNT` and `REGION` placeholders in `deploy/`.
#
# Outputs rather than variables on the manifest side: the account is whatever we actually applied
# into, confirmed by `aws_caller_identity`, not whatever a variable claimed. The `check` block in
# `main.tf` asserts the two agree; this is the value that was true.
output "aws_account_id" {
  description = "Account these resources live in, as observed rather than as declared"
  value       = data.aws_caller_identity.current.account_id
}

output "aws_region" {
  description = "Region these resources live in"
  value       = var.aws_region
}

output "alb_dns_name" {
  description = "Where Route 53 points both the control-plane domain and the tenant wildcard"
  value       = aws_lb.main.dns_name
}

output "alb_zone_id" {
  description = "Hosted zone of the ALB, for an alias record"
  value       = aws_lb.main.zone_id
}

output "platform_cache_endpoint" {
  description = "The platform Valkey the router reads routes from"
  value       = aws_elasticache_replication_group.platform.primary_endpoint_address
}

output "lambda_execution_role_arn" {
  description = "LAMBDA_EXECUTION_ROLE_ARN for the control plane"
  value       = aws_iam_role.lambda_execution.arn
}

output "listener_arn" {
  description = "LISTENER_ARN for the deploy workflow: the router's traffic is this listener's default action"
  value       = aws_lb_listener.https.arn
}

output "website_rule_arn" {
  description = "WEBSITE_RULE_ARN for the deploy workflow: the website is a host-matched rule, not the default"
  value       = aws_lb_listener_rule.website.arn
}
