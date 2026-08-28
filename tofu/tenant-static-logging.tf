/*
  Durable request accounting for the shared tenant-static CloudFront distribution.

  Standard logging v2 has no sampling control: this delivery selects every request record
  CloudFront makes available and writes it as W3C to the dedicated `tenant-static/` prefix. The
  background worker persists its scan cursor, backfills the bucket's retention window on first
  use, and overlaps the cursor for late delivery because AWS says records can be delayed 24 hours.

  FUTURE: if seconds-level usage visibility becomes necessary, add CloudFront **real-time** logs at
  a 100% sampling rate and deliver them to Kinesis. That paid path is deliberately not enabled now;
  S3 standard logging v2 is the durable, lower-cost launch path.
*/

resource "aws_s3_bucket" "tenant_static_logs" {
  bucket = "${var.name_prefix}-tenant-static-logs-${var.aws_account_id}"
  tags   = local.tags
}

resource "aws_s3_bucket_server_side_encryption_configuration" "tenant_static_logs" {
  bucket = aws_s3_bucket.tenant_static_logs.id

  rule {
    apply_server_side_encryption_by_default {
      # CloudWatch vended-log delivery supports SSE-S3 without a broad KMS service grant. The
      # bucket is dedicated to logs, so a customer-managed key would add calls and policy surface
      # without adding a tenant boundary.
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "tenant_static_logs" {
  bucket = aws_s3_bucket.tenant_static_logs.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "tenant_static_logs" {
  bucket = aws_s3_bucket.tenant_static_logs.id

  rule {
    id     = "expire-imported-standard-logs"
    status = "Enabled"

    filter { prefix = "tenant-static/" }

    # ClickHouse is the durable usage ledger after import. Keeping the source objects for ninety
    # days preserves a generous replay/audit window without making raw CDN logs permanent storage.
    expiration { days = 90 }
  }
}

resource "aws_s3_bucket_policy" "tenant_static_logs" {
  bucket     = aws_s3_bucket.tenant_static_logs.id
  depends_on = [aws_s3_bucket_public_access_block.tenant_static_logs]

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AWSLogDeliveryAclCheck"
        Effect    = "Allow"
        Principal = { Service = "delivery.logs.amazonaws.com" }
        Action    = ["s3:GetBucketAcl", "s3:ListBucket"]
        Resource  = aws_s3_bucket.tenant_static_logs.arn
        Condition = {
          StringEquals = { "aws:SourceAccount" = var.aws_account_id }
          ArnLike = {
            "aws:SourceArn" = "arn:aws:logs:us-east-1:${var.aws_account_id}:delivery-source:*"
          }
        }
      },
      {
        Sid       = "AWSLogDeliveryWrite"
        Effect    = "Allow"
        Principal = { Service = "delivery.logs.amazonaws.com" }
        Action    = "s3:PutObject"
        Resource  = "${aws_s3_bucket.tenant_static_logs.arn}/tenant-static/*"
        Condition = {
          StringEquals = {
            "aws:SourceAccount" = var.aws_account_id
            "s3:x-amz-acl"      = "bucket-owner-full-control"
          }
          ArnLike = {
            "aws:SourceArn" = "arn:aws:logs:us-east-1:${var.aws_account_id}:delivery-source:*"
          }
        }
      },
    ]
  })
}

resource "aws_cloudwatch_log_delivery_source" "tenant_static" {
  name         = "${var.name_prefix}-tenant-static-access"
  log_type     = "ACCESS_LOGS"
  resource_arn = aws_cloudfront_distribution.tenant_static.arn
}

resource "aws_cloudwatch_log_delivery_destination" "tenant_static" {
  name          = "${var.name_prefix}-tenant-static-s3"
  output_format = "w3c"

  delivery_destination_configuration {
    destination_resource_arn = "${aws_s3_bucket.tenant_static_logs.arn}/tenant-static"
  }
}

resource "aws_cloudwatch_log_delivery" "tenant_static" {
  delivery_source_name     = aws_cloudwatch_log_delivery_source.tenant_static.name
  delivery_destination_arn = aws_cloudwatch_log_delivery_destination.tenant_static.arn
  field_delimiter          = "\t"
  record_fields = [
    "date",
    "time",
    "timestamp(ms)",
    "x-edge-request-id",
    "x-host-header",
    "sc-bytes",
    "viewer-request-log-data",
  ]

  s3_delivery_configuration {
    enable_hive_compatible_path = false
    suffix_path                 = "{yyyy}/{MM}/{dd}"
  }

  depends_on = [aws_s3_bucket_policy.tenant_static_logs]
}

output "tenant_static_log_bucket" {
  description = "Encrypted standard-v2 CloudFront logs imported into canonical usage events."
  value       = aws_s3_bucket.tenant_static_logs.id
}

# A durable reconciliation row is the audit record; these metrics make lag and a settled residual
# visible without an operator polling Postgres. Pending delivery is expected inside the grace
# window, while platform overhead means AWS still observed usage after that window closed.
resource "aws_cloudwatch_log_metric_filter" "tenant_static_pending_delivery" {
  name           = "${var.name_prefix}-tenant-static-pending-delivery"
  log_group_name = aws_cloudwatch_log_group.ecs.name
  pattern        = "{ $.event = \"static_cloudfront_usage_reconciliation\" && $.status = \"pending_delivery\" }"

  metric_transformation {
    name      = "StaticCloudFrontPendingDeliveryDays"
    namespace = "SproutOS/Billing"
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "tenant_static_platform_overhead" {
  name           = "${var.name_prefix}-tenant-static-platform-overhead"
  log_group_name = aws_cloudwatch_log_group.ecs.name
  pattern        = "{ $.event = \"static_cloudfront_usage_reconciliation\" && $.status = \"platform_overhead\" }"

  metric_transformation {
    name      = "StaticCloudFrontPlatformOverheadDays"
    namespace = "SproutOS/Billing"
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "tenant_static_platform_overhead" {
  alarm_name          = "${var.name_prefix}-tenant-static-platform-overhead"
  alarm_description   = "CloudFront provider totals still exceed attributable static usage after the delivery grace period. Residual is platform overhead, never tenant usage."
  namespace           = "SproutOS/Billing"
  metric_name         = "StaticCloudFrontPlatformOverheadDays"
  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  tags = local.tags
}
