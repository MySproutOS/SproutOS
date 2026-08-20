resource "aws_cloudfront_origin_access_control" "spa" {
  name                              = "spa-s3-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_response_headers_policy" "spa_cors" {
  name = "spa-cors"

  cors_config {
    access_control_allow_credentials = false
    access_control_max_age_sec       = 600
    origin_override                  = true

    access_control_allow_origins {
      items = ["https://nextjs-spa-split.andrewcwang.com"]
    }

    access_control_allow_methods {
      items = ["GET", "HEAD", "OPTIONS"]
    }

    access_control_allow_headers {
      items = ["*"]
    }
  }
}

resource "aws_cloudfront_distribution" "spa" {
  enabled             = true
  default_root_object = "dashboard/index.html"
  price_class         = "PriceClass_100"
  comment             = "SPA assets for nextjs-spa-split"


  origin {
    domain_name              = aws_s3_bucket.spa.bucket_regional_domain_name
    origin_id                = "s3-spa"
    origin_access_control_id = aws_cloudfront_origin_access_control.spa.id
  }

  # Default: cache hashed assets (immutable)
  default_cache_behavior {
    target_origin_id       = "s3-spa"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_optimized.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.spa_cors.id
  }

  # dashboard/index.html — no caching
  ordered_cache_behavior {
    path_pattern           = "/dashboard/index.html"
    target_origin_id       = "s3-spa"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_disabled.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.spa_cors.id
  }

  # admin/index.html — no caching
  ordered_cache_behavior {
    path_pattern           = "/admin/index.html"
    target_origin_id       = "s3-spa"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_disabled.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.spa_cors.id
  }

  # SPA fallback: 403 (access denied from S3) → serve index.html
  custom_error_response {
    error_code            = 403
    response_code         = 200
    response_page_path    = "/dashboard/index.html"
    error_caching_min_ttl = 0
  }

  custom_error_response {
    error_code            = 404
    response_code         = 200
    response_page_path    = "/dashboard/index.html"
    error_caching_min_ttl = 0
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}

data "aws_cloudfront_cache_policy" "caching_optimized" {
  name = "Managed-CachingOptimized"
}

data "aws_cloudfront_cache_policy" "caching_disabled" {
  name = "Managed-CachingDisabled"
}
