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

output "cluster_name" {
  description = "EKS cluster name, for `aws eks update-kubeconfig`"
  value       = aws_eks_cluster.main.name
}

output "cluster_endpoint" {
  description = "Kubernetes API endpoint"
  value       = aws_eks_cluster.main.endpoint
}

output "cluster_oidc_issuer" {
  description = "OIDC issuer URL, for IRSA trust policies"
  value       = aws_eks_cluster.main.identity[0].oidc[0].issuer
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
