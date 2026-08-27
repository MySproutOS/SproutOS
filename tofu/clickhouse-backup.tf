/**
 * Off-host durability for the ClickHouse financial event store.
 *
 * OpenTofu creates the bucket and the least-privilege identity, but deliberately does not create
 * `aws_iam_access_key`: that resource writes the secret into state forever. Create the one runtime
 * key out of band and put it only in `/opt/sproutos/.env` on the OVH host, following ovh/README.md.
 */

resource "aws_s3_bucket" "clickhouse_backups" {
  bucket = "${var.name_prefix}-clickhouse-backups-${var.aws_account_id}"
  tags   = merge(local.tags, { Purpose = "ClickHouse financial metering backups" })
}

resource "aws_s3_bucket_public_access_block" "clickhouse_backups" {
  bucket = aws_s3_bucket.clickhouse_backups.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "clickhouse_backups" {
  bucket = aws_s3_bucket.clickhouse_backups.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "clickhouse_backups" {
  bucket = aws_s3_bucket.clickhouse_backups.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "clickhouse_backups" {
  bucket = aws_s3_bucket.clickhouse_backups.id

  rule {
    id     = "retain-daily-backups-35-days"
    status = "Enabled"
    filter { prefix = "clickhouse/" }

    expiration { days = 35 }
    noncurrent_version_expiration { noncurrent_days = 7 }
    abort_incomplete_multipart_upload { days_after_initiation = 1 }
  }
}

resource "aws_s3_bucket_policy" "clickhouse_backups" {
  bucket = aws_s3_bucket.clickhouse_backups.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyPlaintextTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource = [
        aws_s3_bucket.clickhouse_backups.arn,
        "${aws_s3_bucket.clickhouse_backups.arn}/*"
      ]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}

resource "aws_iam_user" "clickhouse_backup" {
  name = "${var.name_prefix}-clickhouse-backup"
  path = "/service/"
  tags = { Purpose = "OVH ClickHouse native backup only" }
}

resource "aws_iam_user_policy" "clickhouse_backup" {
  name = "clickhouse-backup-prefix-only"
  user = aws_iam_user.clickhouse_backup.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadBucketMetadataFromTheBackupHost"
        Effect   = "Allow"
        Action   = ["s3:GetBucketLocation", "s3:ListBucketMultipartUploads"]
        Resource = aws_s3_bucket.clickhouse_backups.arn
        Condition = {
          IpAddress = { "aws:SourceIp" = ["135.148.122.203/32"] }
        }
      },
      {
        Sid      = "ListOnlyTheBackupPrefix"
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = aws_s3_bucket.clickhouse_backups.arn
        Condition = {
          StringLike = { "s3:prefix" = ["clickhouse", "clickhouse/*"] }
          IpAddress  = { "aws:SourceIp" = ["135.148.122.203/32"] }
        }
      },
      {
        Sid    = "ReadWriteOnlyBackupObjects"
        Effect = "Allow"
        Action = [
          "s3:AbortMultipartUpload",
          "s3:DeleteObject",
          "s3:GetObject",
          "s3:ListMultipartUploadParts",
          "s3:PutObject"
        ]
        Resource = "${aws_s3_bucket.clickhouse_backups.arn}/clickhouse/*"
        Condition = {
          IpAddress = { "aws:SourceIp" = ["135.148.122.203/32"] }
        }
      }
    ]
  })
}

output "clickhouse_backup_s3_endpoint" {
  description = "Set as CLICKHOUSE_BACKUP_S3_ENDPOINT on OVH; contains no credential."
  value       = "https://${aws_s3_bucket.clickhouse_backups.bucket}.s3.${var.aws_region}.amazonaws.com/clickhouse/"
}

output "clickhouse_backup_iam_user" {
  description = "Create its single runtime access key out of band; OpenTofu intentionally creates none."
  value       = aws_iam_user.clickhouse_backup.name
}
