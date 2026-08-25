/**
 * Static assets for the forum, on their own bucket and their own distribution.
 *
 * The forum itself runs on the OVH box and answers `forum.sproutos.me` (see `dns.tf`). Its static
 * assets do not belong there: a single rented machine already carries ClickHouse, Kafka, tenant
 * Valkey and OpenSearch, and serving avatars and CSS from it spends the one resource that box has
 * no more of — bandwidth on a link every tenant's search and queue traffic also crosses.
 *
 * So the bytes come from S3 through CloudFront, and the forum only ever renders URLs pointing at
 * them. It is also the cheaper half by a wide margin: CloudFront's first tier is $0.085/GB against
 * an OVH box whose throughput is shared with everything else it does.
 *
 * Uploaded from `SproutOS-Agent/SproutOS-Agent-Forum` by a role of its own, which can write this
 * bucket and invalidate this distribution and do nothing else in the account.
 */

locals {
  forum_static_host = "static.${var.forum_subdomain}.${var.control_plane_domain}"

  # Production only. There is one account today, so this is a gate rather than a workspace split —
  # but writing it as a condition means a staging deployment does not silently get a second
  # distribution on the same hostname, which is a conflict that surfaces as a certificate that
  # never validates.
  forum_static_enabled = var.environment == "production" ? 1 : 0
}

resource "aws_s3_bucket" "forum_static" {
  count  = local.forum_static_enabled
  bucket = "${var.name_prefix}-forum-static-${var.aws_account_id}"
  tags   = merge(local.tags, { Name = "${var.name_prefix}-forum-static" })
}

# Private, and reached only through CloudFront. A public bucket would work and would also be a
# bucket anyone can enumerate and bill us for.
resource "aws_s3_bucket_public_access_block" "forum_static" {
  count  = local.forum_static_enabled
  bucket = aws_s3_bucket.forum_static[0].id

  block_public_acls       = true
  ignore_public_acls      = true
  block_public_policy     = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "forum_static" {
  count  = local.forum_static_enabled
  bucket = aws_s3_bucket.forum_static[0].id

  rule {
    # SSE-S3, not KMS. These are public assets served to anonymous readers, so a customer-managed
    # key would buy nothing and would put a KMS call on the path of every cache miss — and, as the
    # release bucket taught us, a second permission on every reader and writer.
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "forum_static" {
  count  = local.forum_static_enabled
  bucket = aws_s3_bucket.forum_static[0].id
  versioning_configuration { status = "Enabled" }
}

/*
  Old versions expire; the current one never does.

  Versioning is here so a bad deploy is recoverable, not so every asset ever uploaded is kept
  forever. Without this rule a bucket of hashed build output grows without bound and is billed
  without bound, and nothing ever reads the old objects — the hash in the filename means a changed
  asset is a new key, not a new version of an old one.
*/
resource "aws_s3_bucket_lifecycle_configuration" "forum_static" {
  count      = local.forum_static_enabled
  bucket     = aws_s3_bucket.forum_static[0].id
  depends_on = [aws_s3_bucket_versioning.forum_static]

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

resource "aws_cloudfront_origin_access_control" "forum_static" {
  count                             = local.forum_static_enabled
  name                              = "${var.name_prefix}-forum-static-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_s3_bucket_policy" "forum_static" {
  count      = local.forum_static_enabled
  bucket     = aws_s3_bucket.forum_static[0].id
  depends_on = [aws_s3_bucket_public_access_block.forum_static]

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowCloudFrontOAC"
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.forum_static[0].arn}/*"
      # Scoped to this distribution, not to CloudFront generally. Without the condition, *any*
      # CloudFront distribution in any account could be pointed at this bucket.
      Condition = {
        StringEquals = {
          "AWS:SourceArn" = aws_cloudfront_distribution.forum_static[0].arn
        }
      }
    }]
  })
}

/*
  Its own certificate, because a wildcard covers exactly one label.

  `*.sproutos.me` matches `forum.sproutos.me` and does **not** match
  `static.forum.sproutos.me` — that is DNS, not ACM. The existing tenant certificate is therefore no
  help here and a distribution using it would fail every handshake on this name.

  CloudFront reads certificates only from `us-east-1`, which is where this deployment already is. In
  any other region this would need a second provider alias, and the error for getting it wrong is
  "the certificate was not found" rather than anything about regions.
*/
resource "aws_acm_certificate" "forum_static" {
  count             = local.forum_static_enabled
  domain_name       = local.forum_static_host
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = merge(local.tags, { Name = local.forum_static_host })
}

resource "aws_route53_record" "forum_static_validation" {
  for_each = local.forum_static_enabled == 0 ? {} : {
    for option in aws_acm_certificate.forum_static[0].domain_validation_options :
    option.domain_name => option
  }

  zone_id         = data.aws_route53_zone.main.zone_id
  name            = each.value.resource_record_name
  type            = each.value.resource_record_type
  records         = [each.value.resource_record_value]
  ttl             = 60
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "forum_static" {
  count                   = local.forum_static_enabled
  certificate_arn         = aws_acm_certificate.forum_static[0].arn
  validation_record_fqdns = [for record in aws_route53_record.forum_static_validation : record.fqdn]
}

resource "aws_cloudfront_distribution" "forum_static" {
  count       = local.forum_static_enabled
  enabled     = true
  price_class = "PriceClass_100"
  comment     = "SproutOS forum static assets"
  aliases     = [local.forum_static_host]

  # IPv6 costs nothing and the forum's own host is dual-stack; a reader on an IPv6-only network
  # should not get the page and lose the images.
  is_ipv6_enabled = true

  origin {
    domain_name              = aws_s3_bucket.forum_static[0].bucket_regional_domain_name
    origin_id                = "s3-forum-static"
    origin_access_control_id = aws_cloudfront_origin_access_control.forum_static[0].id
  }

  default_cache_behavior {
    target_origin_id       = "s3-forum-static"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_optimized.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.forum_static_cors[0].id
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate {
    acm_certificate_arn = aws_acm_certificate_validation.forum_static[0].certificate_arn
    ssl_support_method  = "sni-only"
    # TLS 1.2 is the floor CloudFront offers with SNI. Anything older is a client that should not be
    # reading a forum in 2026.
    minimum_protocol_version = "TLSv1.2_2021"
  }

  tags = merge(local.tags, { Name = "${var.name_prefix}-forum-static" })
}

/*
  CORS for the forum's own origin, and no other.

  Fonts and anything fetched by script are subject to CORS even when the bytes are public, so a
  distribution with no policy serves images fine and fails on a webfont — with a console error that
  names the font rather than the header.
*/
resource "aws_cloudfront_response_headers_policy" "forum_static_cors" {
  count = local.forum_static_enabled
  name  = "${var.name_prefix}-forum-static-cors"

  cors_config {
    access_control_allow_credentials = false
    access_control_max_age_sec       = 86400
    origin_override                  = true

    access_control_allow_origins {
      items = ["https://${var.forum_subdomain}.${var.control_plane_domain}"]
    }

    access_control_allow_methods {
      items = ["GET", "HEAD", "OPTIONS"]
    }

    access_control_allow_headers {
      items = ["*"]
    }
  }
}

resource "aws_route53_record" "forum_static_ipv4" {
  count   = local.forum_static_enabled
  zone_id = data.aws_route53_zone.main.zone_id
  name    = local.forum_static_host
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.forum_static[0].domain_name
    zone_id                = aws_cloudfront_distribution.forum_static[0].hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "forum_static_ipv6" {
  count   = local.forum_static_enabled
  zone_id = data.aws_route53_zone.main.zone_id
  name    = local.forum_static_host
  type    = "AAAA"

  alias {
    name                   = aws_cloudfront_distribution.forum_static[0].domain_name
    zone_id                = aws_cloudfront_distribution.forum_static[0].hosted_zone_id
    evaluate_target_health = false
  }
}

/*
  The role the forum's own repository assumes to publish assets.

  A separate role from `sproutos-deploy`, deliberately. That one can write releases, scale the
  service groups and move production traffic; this one can write one bucket and invalidate one
  distribution. They are different repositories with different sets of people able to merge to them,
  and a shared role would make the smaller of the two a way to deploy the platform.

  `SproutOS-Agent/SproutOS-Agent-Forum` is a **public** repository, which raises the stakes on the
  `sub` condition rather than lowering them: a pull request from a fork must never be able to assume
  this. It cannot — `ref:refs/heads/main` is a branch in *this* repository, and a fork's workflow
  carries its own repository in the claim — but that is the reason the condition is a branch ref and
  not `repo:...:*`.
*/
resource "aws_iam_role" "forum_static_deploy" {
  count = local.forum_static_enabled
  name  = "${var.name_prefix}-forum-static-deploy"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRoleWithWebIdentity"
      Principal = { Federated = aws_iam_openid_connect_provider.github.arn }
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        }
        # Both spellings, for the same reason as the deploy role — this owner also issues
        # id-qualified subjects. See `github_repo_ids` in `variables.tf`.
        StringLike = {
          "token.actions.githubusercontent.com:sub" = compact([
            "repo:${var.forum_repo}:ref:refs/heads/main",
            var.forum_repo_ids == "" ? "" : "repo:${var.forum_repo_ids}:ref:refs/heads/main",
          ])
        }
      }
    }]
  })

  tags = local.tags
}

resource "aws_iam_role_policy" "forum_static_deploy" {
  count = local.forum_static_enabled
  name  = "publish-forum-static"
  role  = aws_iam_role.forum_static_deploy[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"]
        Resource = "${aws_s3_bucket.forum_static[0].arn}/*"
      },
      {
        # Needed by `aws s3 sync` to work out what is already there. Without it the sync uploads
        # every object on every run, which is correct and slow and billed.
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = aws_s3_bucket.forum_static[0].arn
      },
      {
        # Hashed filenames make most invalidations unnecessary, but anything served at a stable path
        # — a favicon, a manifest — needs one, and a deploy that cannot invalidate is a deploy whose
        # effect is up to a cache.
        Effect   = "Allow"
        Action   = ["cloudfront:CreateInvalidation"]
        Resource = aws_cloudfront_distribution.forum_static[0].arn
      },
    ]
  })
}
