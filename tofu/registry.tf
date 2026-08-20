/**
 * The registry, and where build artefacts live.
 *
 * One repository per deployable rather than one shared with tag prefixes: a repository is the unit
 * an IAM policy and a lifecycle rule can name, so a shared one means the build role that pushes the
 * website can also replace the image the pg-proxy is about to pull.
 */

locals {
  # Every image the platform builds. Tenant images are not here — those are built per project and
  # belong in a separate repository namespace with per-tenant policy, which is phase 10's problem.
  platform_images = [
    "website",
    "internal-api",
    "worker",
    "pg-proxy",
    "valkey-proxy",
    "search-proxy",
    "metering-agent",
  ]
}

resource "aws_ecr_repository" "platform" {
  for_each = toset(local.platform_images)

  name = "${var.name_prefix}/${each.value}"
  # `IMMUTABLE`, so a tag means one image forever. A mutable `:latest` is how a rollback rolls
  # forward into the thing it was rolling back from.
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.secrets.arn
  }

  tags = local.tags
}

/*
  Keep the last 30 images, expire untagged after a day.

  Untagged images are build layers nothing references; they accumulate at the rate of the CI
  pipeline and are billed per gigabyte-month. Thirty tagged images is more rollback depth than
  anyone has ever used and still bounded.
*/
resource "aws_ecr_lifecycle_policy" "platform" {
  for_each = aws_ecr_repository.platform

  repository = each.value.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images after a day"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 1
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep the last 30 tagged images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 30
        }
        action = { type = "expire" }
      },
    ]
  })
}

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
