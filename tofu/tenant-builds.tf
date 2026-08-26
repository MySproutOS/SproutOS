/**
 * Where a customer's build archive lands, and what Lambda publishes from.
 *
 * ## Why not the artifacts bucket
 *
 * `deploy.ts` signed uploads for `SERVICE_BUILD_BUCKET`, whose fallback named a bucket that exists
 * in no account; pointing it at `aws_s3_bucket.artifacts` would have worked and been wrong. That
 * bucket holds the platform's own releases under `releases/` and the Postgres split's server
 * certificate under `tls/`, and the instance role is deliberately granted **read only, per prefix**
 * on it. Granting `s3:PutObject` there to accept customer uploads would put a write grant on the
 * bucket the control plane boots from — a customer archive and the platform's own release, one
 * bucket policy apart.
 *
 * Separate bucket, same shape as `tenant-static.tf`: shared by every project, with the key prefix
 * as the tenancy boundary, because the project id in `builds/<project_id>/<digest>.zip` comes from
 * the deploy token and never from the request body.
 *
 * ## The permission that has to exist
 *
 * A presigned URL carries the *signer's* authority — the deploy action holds no AWS credential of
 * its own. `tenant-static.tf`'s sibling grant in `compute.tf` says exactly this, and the build
 * archive, the other half of the same deploy, had no grant at all. The symptom was a `403` from S3
 * in a customer's CI naming nobody.
 */

resource "aws_s3_bucket" "tenant_builds" {
  bucket = "${var.name_prefix}-tenant-builds-${var.aws_account_id}"
  tags   = local.tags
}

/*
  No versioning, for the same reason as the assets bucket: an object is named by the digest of its
  own contents, so a rebuild of unchanged sources writes identical bytes to the same key and there
  is no previous version worth keeping.
*/

resource "aws_s3_bucket_server_side_encryption_configuration" "tenant_builds" {
  bucket = aws_s3_bucket.tenant_builds.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.secrets.arn
    }
    # A build archive routinely carries a bundled `.env` a customer did not mean to ship, so this is
    # encrypted like the assets bucket rather than left on SSE-S3.
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "tenant_builds" {
  bucket = aws_s3_bucket.tenant_builds.id

  # Nothing reads from here but Lambda, through the publish call. There is no case for a public
  # object, and the bucket is shared by every tenant.
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "tenant_builds" {
  bucket = aws_s3_bucket.tenant_builds.id

  /*
    Uploads that were signed and never completed: a presigned PUT expires in fifteen minutes, but a
    multipart upload that got part of the way leaves parts behind that are billed and that no
    listing shows.
  */
  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

output "tenant_builds_bucket" {
  description = "Shared bucket for tenant build archives, keyed by project id."
  value       = aws_s3_bucket.tenant_builds.id
}
