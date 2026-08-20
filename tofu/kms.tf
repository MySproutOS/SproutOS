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
}

resource "aws_kms_alias" "secrets" {
  name          = "alias/${var.name_prefix}-secrets"
  target_key_id = aws_kms_key.secrets.key_id
}

/*
  A separate key for EKS secret envelope encryption.

  Kubernetes Secrets are base64, not encryption. Without a KMS key on the cluster they sit in etcd
  in the clear, which means every backup of etcd is a copy of every credential the platform holds.
*/
resource "aws_kms_key" "eks" {
  description             = "SproutOS EKS secret envelope encryption"
  enable_key_rotation     = true
  deletion_window_in_days = local.key_deletion_window
  tags                    = merge(local.tags, { Name = "${var.name_prefix}-eks" })
}

resource "aws_kms_alias" "eks" {
  name          = "alias/${var.name_prefix}-eks"
  target_key_id = aws_kms_key.eks.key_id
}
