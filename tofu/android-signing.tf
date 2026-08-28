/**
 * Android release custody.
 *
 * The on-premises signer is deliberately not an AWS workload. It polls the public API over TLS
 * and receives short-lived, exact-object presigned URLs. It has no IAM user, access key, role, or
 * inbound listener. AWS therefore stores only the customer's raw APK, the signer-encrypted
 * keystore ciphertext, and the verified signed APK; the master identity that can open a keystore
 * never enters this account.
 *
 * One dedicated bucket and key keep this trust boundary out of the general build bucket. The API
 * task can broker an exact object through a presigned URL, but neither it nor the signer can delete
 * a keystore. Versioning is part of the database contract: android_app stores the VersionId of the
 * encrypted keystore object that belongs to that app.
 */

resource "aws_kms_key" "android_artifacts" {
  description             = "SproutOS private raw, signed and encrypted Android release artifacts"
  enable_key_rotation     = true
  deletion_window_in_days = 30

  # Losing this key loses every encrypted app key and makes installed applications permanently
  # un-upgradeable. Removing it must be a deliberate two-step change, never collateral from a
  # broad destroy or a renamed resource.
  lifecycle {
    prevent_destroy = true
  }

  tags = merge(local.tags, { Name = "${var.name_prefix}-android-artifacts" })
}

resource "aws_kms_alias" "android_artifacts" {
  name          = "alias/${var.name_prefix}-android-artifacts"
  target_key_id = aws_kms_key.android_artifacts.key_id
}

resource "aws_s3_bucket" "android_artifacts" {
  bucket        = "${var.name_prefix}-android-artifacts-${var.aws_account_id}"
  force_destroy = false

  # The bucket contains the only durable copies of encrypted per-app signing keys. Even an empty
  # bucket should not disappear because a resource was moved or renamed accidentally.
  lifecycle {
    prevent_destroy = true
  }

  tags = merge(local.tags, { Name = "${var.name_prefix}-android-artifacts" })
}

resource "aws_s3_bucket_public_access_block" "android_artifacts" {
  bucket = aws_s3_bucket.android_artifacts.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "android_artifacts" {
  bucket = aws_s3_bucket.android_artifacts.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "android_artifacts" {
  bucket = aws_s3_bucket.android_artifacts.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "android_artifacts" {
  bucket = aws_s3_bucket.android_artifacts.id

  # Default encryption is intentional. Presigned PUTs name Content-Type and Content-Length only;
  # requiring the on-prem signer to reproduce x-amz-server-side-encryption headers would couple
  # the no-AWS-credential client to an AWS storage detail and make an otherwise valid PUT fail its
  # signature check. S3 applies this KMS key after accepting the upload.
  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.android_artifacts.arn
      sse_algorithm     = "aws:kms"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "android_artifacts" {
  bucket     = aws_s3_bucket.android_artifacts.id
  depends_on = [aws_s3_bucket_versioning.android_artifacts]

  # A raw APK is retained long enough to diagnose and retry signing, but it is not a distributable
  # artifact and does not need indefinite retention after a verified signed release exists.
  rule {
    id     = "expire-raw-apks"
    status = "Enabled"

    filter {
      prefix = "raw/"
    }

    expiration {
      days = var.android_raw_apk_retention_days
    }

    noncurrent_version_expiration {
      noncurrent_days = 7
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }

  # A successful release remains downloadable until the control plane explicitly supersedes or
  # removes it. Only overwritten, noncurrent bytes age out; normal signed keys include the signer
  # job identity and therefore do not overwrite one another.
  rule {
    id     = "retain-signed-apks"
    status = "Enabled"

    filter {
      prefix = "signed/"
    }

    noncurrent_version_expiration {
      noncurrent_days = 90
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }

  # There is intentionally no expiration for keys/. The ciphertext is small, and every version
  # may be needed to recover from an interrupted key update. A lifecycle rule that treated the
  # bucket uniformly would turn a cheap storage cleanup into an unrecoverable application identity.
  rule {
    id     = "retain-encrypted-signing-keys"
    status = "Enabled"

    filter {
      prefix = "keys/"
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

resource "aws_s3_bucket_policy" "android_artifacts" {
  bucket     = aws_s3_bucket.android_artifacts.id
  depends_on = [aws_s3_bucket_public_access_block.android_artifacts]

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyPlaintextTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource = [
          aws_s3_bucket.android_artifacts.arn,
          "${aws_s3_bucket.android_artifacts.arn}/*",
        ]
        Condition = {
          Bool = { "aws:SecureTransport" = "false" }
        }
      },
      {
        # The presigned protocol intentionally omits encryption headers and relies on the immutable
        # bucket default. Refuse a caller-supplied algorithm so a bearer of a still-live PUT URL
        # cannot replace SSE-KMS with SSE-S3, DSSE-KMS, or another KMS key.
        Sid       = "DenyExplicitEncryptionOverride"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:PutObject"
        Resource  = "${aws_s3_bucket.android_artifacts.arn}/*"
        Condition = {
          Null = { "s3:x-amz-server-side-encryption" = "false" }
        }
      },
      {
        # SSE-C would make the object unreadable as soon as the caller discarded its supplied key.
        # New S3 buckets block SSE-C by default, but keep that custody invariant explicit here too.
        Sid       = "DenyCustomerProvidedEncryption"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:PutObject"
        Resource  = "${aws_s3_bucket.android_artifacts.arn}/*"
        Condition = {
          Null = { "s3:x-amz-server-side-encryption-customer-algorithm" = "false" }
        }
      },
      {
        # CopyObject authorizes as PutObject. Nothing in the signing protocol copies an object;
        # refusing the copy-source header stops a valid URL from being repurposed to move existing
        # bucket bytes across the raw, signed, and recovery-sensitive key prefixes.
        Sid       = "DenyServerSideCopies"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:PutObject"
        Resource  = "${aws_s3_bucket.android_artifacts.arn}/*"
        Condition = {
          Null = { "s3:x-amz-copy-source" = "false" }
        }
      },
    ]
  })
}

resource "aws_iam_policy" "android_custody_broker" {
  name        = "${var.name_prefix}-android-custody-broker"
  description = "Broker exact Android signing objects through the ordinary control-plane task."

  # This is deliberately not part of aws_iam_policy.application. That policy is attached to the
  # legacy EC2 host, Rust router, ordinary ECS task, and ACME task. Only the ordinary control-plane
  # task runs the API/worker code that creates exact presigned custody operations.
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:GetObjectVersion",
          "s3:PutObject",
        ]
        Resource = [
          "${aws_s3_bucket.android_artifacts.arn}/raw/*",
          "${aws_s3_bucket.android_artifacts.arn}/signed/*",
        ]
      },
      {
        # Keep recovery-sensitive encrypted keys independently visible in IAM review.
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:GetObjectVersion",
          "s3:PutObject",
        ]
        Resource = "${aws_s3_bucket.android_artifacts.arn}/keys/*"
      },
      {
        # Bucket Keys make the bucket ARN the encryption context. ViaService and this exact context
        # prevent direct KMS use or use through any other S3 bucket.
        Effect   = "Allow"
        Action   = ["kms:Decrypt", "kms:GenerateDataKey"]
        Resource = aws_kms_key.android_artifacts.arn
        Condition = {
          StringEquals = {
            "kms:ViaService"                   = "s3.${var.aws_region}.amazonaws.com"
            "kms:EncryptionContext:aws:s3:arn" = aws_s3_bucket.android_artifacts.arn
          }
        }
      },
    ]
  })
}

resource "aws_iam_role_policy_attachment" "task_android_custody_broker" {
  role       = aws_iam_role.task.name
  policy_arn = aws_iam_policy.android_custody_broker.arn
}

/*
 * The API reports these namespace-scoped custom metrics from signer polls and normalized job
 * state. The on-prem signer still receives no AWS credential. Alarms are an explicit rollout
 * switch: missing heartbeat data is supposed to alarm, so enabling them before the signer and the
 * notification subscription exist would create a permanent false page.
 */
resource "aws_kms_key" "android_signing_alerts" {
  count = var.android_signing_alarms_enabled ? 1 : 0

  description             = "Encrypt Android signer operational alarm notifications"
  enable_key_rotation     = true
  deletion_window_in_days = 30

  # AWS-managed alias/aws/sns cannot be amended to let a CloudWatch alarm use it. This key exists
  # only when the alarm rollout switch is enabled and grants the publisher no unrelated KMS use.
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "EnableAccountAdministration"
        Effect    = "Allow"
        Principal = { AWS = "arn:aws:iam::${var.aws_account_id}:root" }
        Action    = "kms:*"
        Resource  = "*"
      },
      {
        Sid       = "AllowCloudWatchAlarmPublishing"
        Effect    = "Allow"
        Principal = { Service = "cloudwatch.amazonaws.com" }
        Action    = ["kms:Decrypt", "kms:GenerateDataKey*"]
        Resource  = "*"
        Condition = {
          StringEquals = {
            "aws:SourceAccount" = var.aws_account_id
          }
          ArnLike = {
            "aws:SourceArn" = "arn:aws:cloudwatch:${var.aws_region}:${var.aws_account_id}:alarm:${var.name_prefix}-android-signing-*"
          }
        }
      },
    ]
  })

  tags = merge(local.tags, { Name = "${var.name_prefix}-android-signing-alerts" })
}

resource "aws_sns_topic" "android_signing_alerts" {
  count = var.android_signing_alarms_enabled ? 1 : 0

  name              = "${var.name_prefix}-android-signing-alerts"
  kms_master_key_id = aws_kms_key.android_signing_alerts[0].arn
  tags              = local.tags
}

resource "aws_sns_topic_policy" "android_signing_alerts" {
  count = var.android_signing_alarms_enabled ? 1 : 0

  arn = aws_sns_topic.android_signing_alerts[0].arn
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowSameAccountCloudWatchAlarms"
        Effect    = "Allow"
        Principal = { Service = "cloudwatch.amazonaws.com" }
        Action    = "sns:Publish"
        Resource  = aws_sns_topic.android_signing_alerts[0].arn
        Condition = {
          StringEquals = {
            "AWS:SourceAccount" = var.aws_account_id
          }
          ArnLike = {
            "AWS:SourceArn" = "arn:aws:cloudwatch:${var.aws_region}:${var.aws_account_id}:alarm:${var.name_prefix}-android-signing-*"
          }
        }
      },
    ]
  })
}

resource "aws_cloudwatch_metric_alarm" "android_signer_heartbeat" {
  count = var.android_signing_alarms_enabled ? 1 : 0

  alarm_name          = "${var.name_prefix}-android-signer-heartbeat-missing"
  alarm_description   = "The outbound Android signer has not polled the API within five minutes."
  namespace           = "SproutOS/AndroidSigner"
  metric_name         = "SignerHeartbeatAgeSeconds"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  threshold           = 300
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.android_signing_alerts[0].arn]
  ok_actions          = [aws_sns_topic.android_signing_alerts[0].arn]
  tags                = local.tags
}

resource "aws_cloudwatch_metric_alarm" "android_signing_queue_age" {
  count = var.android_signing_alarms_enabled ? 1 : 0

  alarm_name          = "${var.name_prefix}-android-signing-oldest-job"
  alarm_description   = "The oldest queued Android signer job has waited more than fifteen minutes."
  namespace           = "SproutOS/AndroidSigner"
  metric_name         = "OldestQueuedJobAgeSeconds"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  threshold           = 900
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.android_signing_alerts[0].arn]
  ok_actions          = [aws_sns_topic.android_signing_alerts[0].arn]
  tags                = local.tags
}

resource "aws_cloudwatch_metric_alarm" "android_signing_failures" {
  count = var.android_signing_alarms_enabled ? 1 : 0

  alarm_name          = "${var.name_prefix}-android-signing-failures"
  alarm_description   = "At least one Android signer job entered the terminal failed state."
  namespace           = "SproutOS/AndroidSigner"
  metric_name         = "FailedJobs"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.android_signing_alerts[0].arn]
  tags                = local.tags
}

output "android_artifact_bucket" {
  description = "Private versioned bucket used for raw APKs, encrypted signing keys, and signed APKs."
  value       = aws_s3_bucket.android_artifacts.id
}

output "android_artifact_kms_key_arn" {
  description = "Dedicated SSE-KMS key for the Android artifact bucket; the on-prem master identity is separate."
  value       = aws_kms_key.android_artifacts.arn
}

output "android_signing_alarm_topic_arn" {
  description = "Subscribe the operations destination before enabling Android signing alarms. Null while disabled."
  value       = try(aws_sns_topic.android_signing_alerts[0].arn, null)
}
