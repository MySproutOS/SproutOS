/**
 * Where a tenant's built static assets land.
 *
 * `POST /v1/deploy/static` hands the deploy action a presigned PUT for
 * `static/<project_id>/<digest>.zip`. Until now the bucket name came from `TENANT_STATIC_BUCKET`
 * with a fallback of `sproutos-dev-artifacts` — a bucket that exists in no account, so every
 * tenant static upload in production was signing a URL for somewhere that is not there.
 *
 * ## One bucket, many tenants
 *
 * The key prefix *is* the tenancy boundary, and `deploy.ts` says why it holds: the project id comes
 * from the deploy token and never from the request body, so a caller cannot assemble a key into
 * another project's prefix. A bucket per project would move that boundary into IAM and cap the
 * platform at the account's bucket limit — the same trade `storage.tf` already made and recorded.
 */

resource "aws_s3_bucket" "tenant_static" {
  bucket = "${var.name_prefix}-tenant-static-${var.aws_account_id}"
  tags   = local.tags
}

/*
  No versioning, unlike the artifacts bucket.

  An object here is named by the digest of its own contents, so a changed asset is a new key and an
  unchanged one is the same key written again. There is no previous version to keep — only copies
  of identical bytes, billed monthly.
*/

resource "aws_s3_bucket_server_side_encryption_configuration" "tenant_static" {
  bucket = aws_s3_bucket.tenant_static.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.secrets.arn
    }
    # Every object read would otherwise be its own KMS call, billed per request and rate limited per
    # account — which is precisely the shape of a CDN filling a cold cache.
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "tenant_static" {
  bucket = aws_s3_bucket.tenant_static.id

  # Tenant assets reach browsers through a signed URL or a CDN with an origin access control, never
  # through a public bucket. A tenant who could make one object public could make the bucket public,
  # and the bucket is shared.
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

/*
  Uploads that were signed and never completed.

  A presigned PUT expires in fifteen minutes, but a multipart upload that got part of the way and
  stopped leaves parts behind that are billed and that no listing shows.
*/
resource "aws_s3_bucket_lifecycle_configuration" "tenant_static" {
  bucket = aws_s3_bucket.tenant_static.id

  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

output "tenant_static_bucket" {
  description = "Shared bucket for tenant static assets, keyed by project id."
  value       = aws_s3_bucket.tenant_static.id
}
