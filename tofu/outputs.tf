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
  value       = aws_db_instance.control_plane.endpoint
}

# The ARN, not the secret. The value is fetched at runtime by whatever holds the IAM permission to
# read it; putting it in an output writes it to state in the clear.
output "database_credentials_secret_arn" {
  description = "Secrets Manager ARN holding the control-plane database password"
  value       = aws_db_instance.control_plane.master_user_secret[0].secret_arn
}

output "envelope_kms_key_arn" {
  description = "KMS key `@lib/envelope` wraps data keys with. Set as KMS_KEY_ID."
  value       = aws_kms_key.envelope.arn
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
  description = "Control-plane ALB DNS name; tenant wildcard moves to the NLB when tenant_edge_enabled is true."
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

output "deploy_role_arn" {
  description = "The role the Deploy workflow assumes"
  value       = aws_iam_role.deploy.arn
}

output "cli_release_promotion_role_arn" {
  description = "Least-privilege role assumed after a five-platform CLI release is verified"
  value       = aws_iam_role.github_actions_cli_release_promotion.arn
}

# The API's rule, so the cutover can move it with the other two.
output "api_rule_arn" {
  description = "Listener rule for api.<domain>. Set as the API_RULE_ARN repository variable."
  value       = aws_lb_listener_rule.api.arn
}

output "ecs_web_task_definition_arn" {
  description = "Latest release-registered web task revision used to bootstrap or repair the ECS service pointer."
  value       = data.aws_ecs_task_definition.web.arn
}

output "ecs_acme_worker_task_definition_arn" {
  description = "Exact OpenTofu-registered ACME worker revision to pass as ECS_BASE_ACME_TASK_DEFINITION after an infrastructure apply."
  value       = aws_ecs_task_definition.acme_worker.arn
}

output "acme_worker_rollout_state" {
  description = "Capacity, handler ownership, and fallback-IAM gates checked by the exact ECS task handoff."
  value = {
    capacity_enabled          = var.acme_worker_enabled
    handler_ownership_enabled = var.acme_handler_ownership_enabled
    fallback_iam_enabled      = var.acme_fallback_iam_enabled
  }
}

output "acme_worker_policy_arn" {
  description = "Exact privileged policy whose platform-task attachment is controlled by the fallback-IAM phase."
  value       = aws_iam_policy.acme_worker.arn
}

output "application_policy_arn" {
  description = "Shared application policy checked in place during the final fallback-IAM transition."
  value       = aws_iam_policy.application.arn
}

output "application_policy_document" {
  description = "Reviewed application-policy semantics used for exact live IAM verification."
  value       = aws_iam_policy.application.policy
}

# The search split's rule, so the cutover moves it with the router. Without it a release leaves
# every customer's search service on the colour the router just drained, and the router looks fine.
output "search_rule_arn" {
  description = "Listener rule for search.<domain>. Set as the SEARCH_RULE_ARN repository variable."
  value       = aws_lb_listener_rule.search.arn
}

output "storage_rule_arn" {
  description = "Listener rule for storage.<domain>. Set as the STORAGE_RULE_ARN repository variable."
  value       = aws_lb_listener_rule.storage.arn
}

output "llm_rule_arn" {
  description = "Listener rule for llm.<domain>. Set as the LLM_RULE_ARN repository variable."
  value       = aws_lb_listener_rule.llm.arn
}

# The tenant balancer's listeners, so the cutover moves them with the router. Without these a
# release leaves every customer's database, queue and sandbox egress on the colour just drained.
output "pg_listener_arn" {
  description = "Postgres listener on the tenant NLB. Set as the PG_LISTENER_ARN repository variable."
  value       = aws_lb_listener.postgres.arn
}

output "valkey_listener_arn" {
  description = "Valkey listener on the tenant NLB. Set as the VALKEY_LISTENER_ARN repository variable."
  value       = aws_lb_listener.valkey.arn
}

output "forward_proxy_listener_arn" {
  description = "Serving sandbox egress listener: legacy TLS before cutover, Rust tenant TLS edge afterward. Set as FORWARD_PROXY_LISTENER_ARN."
  value       = aws_lb_listener.forward_proxy.arn
}

output "tenant_http_listener_arn" {
  description = "Rust tenant HTTP/ACME listener on the shared tenant NLB. Set as TENANT_HTTP_LISTENER_ARN."
  value       = one(aws_lb_listener.tenant_http[*].arn)
}

output "tenant_ingress_ipv4_addresses" {
  description = "Stable NLB IPv4 fallback records for customer apex domains without DNS flattening."
  value       = aws_eip.tenant_edge[*].public_ip
}

output "tenant_ingress_ipv6_addresses" {
  description = "Stable NLB IPv6 fallback records for customer apex domains without DNS flattening."
  value       = local.tenant_edge_ipv6_addresses
}

output "tenant_edge_dns_name" {
  description = "Shared dual-stack tenant NLB name for IPv4 and IPv6 edge smoke tests."
  value       = aws_lb.tenant.dns_name
}

output "tenant_edge_preview_ingress" {
  description = "Stable dual-stack preview hostname that reaches HTTP 80 and TLS preview 8444 without moving production traffic."
  value       = local.tenant_edge_provisioned ? "preview-ingress.${var.tenant_domain}" : null
}

output "forum_static_bucket" {
  description = "Bucket the forum's assets are published to."
  value       = one(aws_s3_bucket.forum_static[*].bucket)
}

output "forum_static_distribution_id" {
  description = "CloudFront distribution to invalidate after a forum asset publish."
  value       = one(aws_cloudfront_distribution.forum_static[*].id)
}

output "forum_static_role_arn" {
  description = "Role SproutOS-Agent-Forum assumes to publish. Set as AWS_ROLE_ARN there."
  value       = one(aws_iam_role.forum_static_deploy[*].arn)
}

output "forum_static_host" {
  description = "Where the forum's assets are served from."
  value       = local.forum_static_host
}

/*
  The name servers to set at the registrar for the tenant domain.

  Delegation is the one step of this that OpenTofu cannot do: the domain is registered at Namecheap,
  and nothing in AWS can reach across and change a registrar's records. So the zone is created here,
  its name servers are read from here, and a human — or a browser session acting for one — sets them
  there. Until that is done this zone is authoritative for a domain nobody is asking it about.
*/
output "tenant_zone_name_servers" {
  description = "Set these as the custom DNS servers for the tenant domain at the registrar"
  value       = aws_route53_zone.tenant.name_servers
}

output "tenant_zone_id" {
  description = "Hosted zone id for the tenant domain"
  value       = aws_route53_zone.tenant.zone_id
}
