/**
 * Customer-managed keys, one per purpose.
 *
 * Separate keys rather than one platform key, because a key is the smallest thing an IAM policy can
 * name. One key means every role that needs to decrypt anything can decrypt everything, and the
 * blast radius of a compromised role is the whole platform rather than one system.
 *
 * `envelope` is the one the application actually uses, through `@lib/envelope`: it wraps the data
 * keys that encrypt OAuth tokens and tenant connection credentials. The others protect storage that
 * AWS encrypts on our behalf.
 */

locals {
  # Ten days rather than the 30-day default. Long enough to notice and cancel a mistaken deletion,
  # short enough that a key scheduled for deletion during an incident is not still pending a month
  # later. Seven is the floor.
  key_deletion_window = 10
}

resource "aws_kms_key" "envelope" {
  description = "SproutOS envelope encryption: OAuth tokens and tenant credentials"
  # Rotation is annual and automatic. Old material is retained, so ciphertext written under a
  # previous year's key still decrypts — which is the property that makes rotation safe to enable
  # and forget rather than a migration.
  enable_key_rotation     = true
  deletion_window_in_days = local.key_deletion_window
  tags                    = merge(local.tags, { Name = "${var.name_prefix}-envelope" })
}

resource "aws_kms_alias" "envelope" {
  name          = "alias/${var.name_prefix}-envelope"
  target_key_id = aws_kms_key.envelope.key_id
}

resource "aws_kms_key" "database" {
  description             = "SproutOS control-plane database storage and backups"
  enable_key_rotation     = true
  deletion_window_in_days = local.key_deletion_window
  tags                    = merge(local.tags, { Name = "${var.name_prefix}-database" })
}

resource "aws_kms_alias" "database" {
  name          = "alias/${var.name_prefix}-database"
  target_key_id = aws_kms_key.database.key_id
}

resource "aws_kms_key" "secrets" {
  description             = "SproutOS Secrets Manager"
  enable_key_rotation     = true
  deletion_window_in_days = local.key_deletion_window
  tags                    = merge(local.tags, { Name = "${var.name_prefix}-secrets" })

  /*
    Keep IAM delegation, then grant only this distribution permission to decrypt tenant static
    objects. An S3 bucket policy is not enough for an SSE-KMS origin: CloudFront reads the object as
    its service principal and KMS independently authorizes that decrypt.
  */
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "EnableIAMPermissions"
        Effect    = "Allow"
        Principal = { AWS = "arn:aws:iam::${var.aws_account_id}:root" }
        Action    = "kms:*"
        Resource  = "*"
      },
      {
        Sid       = "AllowTenantStaticCloudFrontDecrypt"
        Effect    = "Allow"
        Principal = { Service = "cloudfront.amazonaws.com" }
        Action    = "kms:Decrypt"
        Resource  = "*"
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = aws_cloudfront_distribution.tenant_static.arn
          }
        }
      },
    ]
  })
}

resource "aws_kms_alias" "secrets" {
  name          = "alias/${var.name_prefix}-secrets"
  target_key_id = aws_kms_key.secrets.key_id
}

/*
  There was a fourth key here, for EKS secret envelope encryption.

  It is gone because the cluster is: ADR 0026 replaced Kubernetes with Lambda and EC2, and this key
  outlived the thing it protected by several months, referenced by nothing but its own alias. A
  customer-managed key is $1 a month whether or not anything ever calls it, so an unused CMK is a
  standing charge for a decision that was already reversed.

  Worth stating because it is the general case rather than a one-off: `tofu plan` reports a resource
  nothing references as perfectly in order, since being unused is not drift.
*/
