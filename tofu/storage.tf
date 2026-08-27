/*
  Tenant object storage: one physical bucket, one prefix per backend service.

  Customers never receive this bucket's name or an AWS credential. They address the logical bucket
  `v-<service-id>` through `storage-proxy`; the proxy authenticates their derived SigV4 key and
  rewrites the request below the same `v-<service-id>/` prefix here. That is the same split used by
  Valkey and OpenSearch: the backing store is shared and the boundary is the proxy we can test.

  Versioning is the recovery boundary. A tenant can delete an object through the proxy, but that
  creates a delete marker and leaves the previous version recoverable for thirty days. The proxy's
  role cannot delete this bucket, alter its policy, or reach any other bucket in the account.
*/

resource "aws_s3_bucket" "tenant_objects" {
  bucket = "${var.name_prefix}-tenant-objects"

  # A service teardown removes only its prefix. The platform bucket itself is never disposable.
  force_destroy = false
  tags          = local.tags
}

resource "aws_s3_bucket_public_access_block" "tenant_objects" {
  bucket = aws_s3_bucket.tenant_objects.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "tenant_objects" {
  bucket = aws_s3_bucket.tenant_objects.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "tenant_objects" {
  bucket = aws_s3_bucket.tenant_objects.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "tenant_objects" {
  bucket = aws_s3_bucket.tenant_objects.id

  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.secrets.arn
      sse_algorithm     = "aws:kms"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_cors_configuration" "tenant_objects" {
  bucket = aws_s3_bucket.tenant_objects.id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["GET", "PUT", "POST", "DELETE", "HEAD"]
    allowed_origins = ["app://obsidian.md", "capacitor://localhost", "http://localhost"]
    expose_headers  = ["ETag", "Content-Length", "x-amz-version-id"]
    max_age_seconds = 3000
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "tenant_objects" {
  bucket = aws_s3_bucket.tenant_objects.id

  rule {
    id     = "recoverable-deletes"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 30
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.tenant_objects]
}
