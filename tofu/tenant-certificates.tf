/*
  Certificates terminated by the Rust tenant edge.

  ACM cannot be used here: the NLB listener is TCP passthrough and the private key must reach
  rustls. The bucket is therefore the durable handoff between the ACME worker and every router
  replica. Object versioning is part of the protocol — custom_domain stores the exact VersionId a
  replica must load and acknowledge, so an overwrite can never make two replicas serve different
  bytes under one database version.
*/
resource "aws_s3_bucket" "tenant_certificates" {
  bucket = "${var.name_prefix}-tenant-certificates-${var.aws_account_id}"
  tags   = merge(local.tags, { Name = "${var.name_prefix}-tenant-certificates" })
}

resource "aws_s3_bucket_public_access_block" "tenant_certificates" {
  bucket = aws_s3_bucket.tenant_certificates.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "tenant_certificates" {
  bucket = aws_s3_bucket.tenant_certificates.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "tenant_certificates" {
  bucket = aws_s3_bucket.tenant_certificates.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "tenant_certificates" {
  bucket = aws_s3_bucket.tenant_certificates.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.secrets.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "tenant_certificates" {
  bucket     = aws_s3_bucket.tenant_certificates.id
  depends_on = [aws_s3_bucket_versioning.tenant_certificates]

  rule {
    id     = "expire-obsolete-certificate-versions"
    status = "Enabled"

    filter {}

    # A router may retain the prior unexpired version while a replacement is rejected. Thirty-five
    # days spans the renewal window plus propagation retries without paying to keep private keys
    # after they can no longer be useful.
    noncurrent_version_expiration {
      noncurrent_days = 35
    }
  }
}

/*
  The account key value is intentionally absent from OpenTofu state. OpenTofu creates only the
  secret container; bin/bootstrap-acme-account-key.sh writes the PEM directly to Secrets Manager
  once. Both exact customer HTTP-01 orders and the platform DNS-01 order reuse that account.
*/
resource "aws_secretsmanager_secret" "acme_account_key" {
  name                    = "${var.name_prefix}/acme/account-key"
  description             = "Let's Encrypt ACME account private key for the tenant edge"
  recovery_window_in_days = 30
  kms_key_id              = aws_kms_key.secrets.arn
  tags                    = local.tags
}

output "tenant_certificate_bucket" {
  description = "Versioned SSE-KMS bucket holding Rust tenant-edge certificate objects."
  value       = aws_s3_bucket.tenant_certificates.id
}

output "acme_account_key_secret_id" {
  description = "Secrets Manager container seeded once by bin/bootstrap-acme-account-key.sh."
  value       = aws_secretsmanager_secret.acme_account_key.id
}
