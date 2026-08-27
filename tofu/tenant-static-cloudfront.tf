/*
  Static tenant releases: immutable S3 objects, one atomic edge pointer per hostname.

  The deploy action uploads a content-addressed zip to `static/<project>/<digest>.zip`. The
  control-plane publisher validates and expands it under `sites/<project>/<digest>/`, then changes
  one CloudFront KVS value from the old prefix to the new. The viewer-request function reads that
  value and rewrites the public URI before cache lookup, so a release or rollback cannot expose a
  half-uploaded tree.

  One distribution serves every `*.sproutos.run` static project. An exact Route 53 record is
  written only when a project publishes the static preset; exact DNS beats the existing wildcard
  that sends Lambda projects to the ALB.
*/

resource "aws_cloudfront_key_value_store" "tenant_static" {
  name    = "${var.name_prefix}-tenant-static-routes"
  comment = "Active immutable prefix for each static tenant hostname"
}

resource "aws_cloudfront_function" "tenant_static" {
  name    = "${var.name_prefix}-tenant-static-route"
  comment = "Map a static tenant hostname to its active content-addressed release"
  runtime = "cloudfront-js-2.0"
  publish = true
  code    = file("${path.module}/functions/tenant-static.js")

  key_value_store_associations = [aws_cloudfront_key_value_store.tenant_static.arn]
}

resource "aws_cloudfront_origin_access_control" "tenant_static" {
  name                              = "${var.name_prefix}-tenant-static-s3-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_response_headers_policy" "tenant_static" {
  name = "${var.name_prefix}-tenant-static-security"

  security_headers_config {
    content_type_options { override = true }
    frame_options {
      frame_option = "SAMEORIGIN"
      override     = true
    }
    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }
    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = true
      preload                    = true
      override                   = true
    }
  }
}

resource "aws_cloudfront_distribution" "tenant_static" {
  enabled         = true
  is_ipv6_enabled = true
  price_class     = "PriceClass_100"
  comment         = "SproutOS tenant static applications"
  aliases         = ["*.${var.tenant_domain}"]

  origin {
    domain_name              = aws_s3_bucket.tenant_static.bucket_regional_domain_name
    origin_id                = "tenant-static-s3"
    origin_access_control_id = aws_cloudfront_origin_access_control.tenant_static.id
  }

  default_cache_behavior {
    target_origin_id       = "tenant-static-s3"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_optimized.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.tenant_static.id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.tenant_static.arn
    }
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.tenant_apps.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}

resource "aws_s3_bucket_policy" "tenant_static" {
  bucket     = aws_s3_bucket.tenant_static.id
  depends_on = [aws_s3_bucket_public_access_block.tenant_static]

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowTenantStaticCloudFrontOAC"
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.tenant_static.arn}/sites/*"
      Condition = {
        StringEquals = {
          "AWS:SourceArn" = aws_cloudfront_distribution.tenant_static.arn
        }
      }
    }]
  })
}

output "tenant_static_distribution_domain" {
  description = "CloudFront origin for static tenant application hostnames."
  value       = aws_cloudfront_distribution.tenant_static.domain_name
}

output "tenant_static_key_value_store_arn" {
  description = "Atomic hostname-to-release map updated by the static publisher."
  value       = aws_cloudfront_key_value_store.tenant_static.arn
}
