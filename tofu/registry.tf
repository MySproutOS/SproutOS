/**
 * Where build artefacts live.
 *
 * There is no container registry any more. Every deployable ships as a release tarball read from
 * the bucket below — the website and the router by an instance at boot, a customer's application as
 * a zip Lambda reads — so the eight ECR repositories that used to be here would be created empty
 * and stay that way. See ADR 0026.
 */

/*
  Build artefacts: tenant source archives, compiled bundles, the things a deploy needs and a running
  service does not.

  Versioned, because a build that overwrote its own artefact leaves nothing to compare against when
  the deploy that used it turns out to be the broken one.
*/
resource "aws_s3_bucket" "artifacts" {
  bucket = "${var.name_prefix}-artifacts"
  tags   = local.tags
}

resource "aws_s3_bucket_versioning" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.secrets.arn
    }
    # Without this, every object read is a separate KMS API call — billed per request and rate
    # limited per account. On a bucket a build pipeline reads in bulk, that is the limit you hit.
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  rule {
    id     = "expire-old-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 30
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}
