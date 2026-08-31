# Origin Access Control is what keeps the bucket private: CloudFront signs its
# origin requests with SigV4, and the bucket policy trusts only this
# distribution's ARN. The older Origin Access Identity still works but is no
# longer the documented path, and it cannot sign against SSE-KMS.
resource "aws_cloudfront_origin_access_control" "site" {
  name                              = "${var.bucket_name}-oac"
  description                       = "Signs CloudFront's requests to the ${var.domain} origin bucket."
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_function" "router" {
  name    = replace("${var.domain}-router", ".", "-")
  runtime = "cloudfront-js-2.0"
  comment = "Canonical host redirect and directory-index rewriting for ${var.domain}."
  publish = true

  code = templatefile("${path.module}/functions/router.js.tftpl", {
    domain       = var.domain
    www_redirect = var.www_redirect
  })
}

resource "aws_cloudfront_response_headers_policy" "site" {
  name    = replace("${var.domain}-security-headers", ".", "-")
  comment = "Baseline security headers for ${var.domain}."

  security_headers_config {
    strict_transport_security {
      access_control_max_age_sec = 63072000
      include_subdomains         = true
      preload                    = false
      override                   = true
    }

    content_type_options {
      override = true
    }

    frame_options {
      frame_option = "DENY"
      override     = true
    }

    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }
  }

  # No Content-Security-Policy here on purpose. Astro and Starlight both emit
  # inline scripts with build-time-generated content, so a useful policy needs
  # hashes that change every build — which means generating it during the build,
  # not pinning it in infrastructure that deploys separately.
}

data "aws_cloudfront_cache_policy" "caching_optimized" {
  name = "Managed-CachingOptimized"
}

resource "aws_cloudfront_distribution" "site" {
  enabled             = true
  is_ipv6_enabled     = true
  comment             = var.domain
  default_root_object = "index.html"
  price_class         = var.price_class
  aliases             = local.aliases

  origin {
    origin_id                = "s3-${aws_s3_bucket.site.id}"
    domain_name              = aws_s3_bucket.site.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.site.id
  }

  default_cache_behavior {
    target_origin_id       = "s3-${aws_s3_bucket.site.id}"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]

    # Brotli and gzip at the edge. The origin stores everything uncompressed, so
    # a deploy never has to think about it.
    compress = true

    # CachingOptimized forwards no cookies or query strings to the origin and
    # honours the Cache-Control the deploy stamps on each object. That is what
    # makes the two-pass upload in the workflow the single place cache lifetimes
    # are decided.
    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_optimized.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.site.id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.router.arn
    }
  }

  # The REST origin returns 403, not 404, for a key that does not exist — S3
  # will not confirm absence to a caller that cannot list the bucket. Both have
  # to become the 404 page, or a mistyped URL renders as an S3 XML error.
  custom_error_response {
    error_code            = 403
    response_code         = 404
    response_page_path    = "/404.html"
    error_caching_min_ttl = 60
  }

  custom_error_response {
    error_code            = 404
    response_code         = 404
    response_page_path    = "/404.html"
    error_caching_min_ttl = 60
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn = aws_acm_certificate_validation.site.certificate_arn
    ssl_support_method  = "sni-only"
    # TLS 1.2 is the floor AWS offers alongside SNI. Nothing that can reach a
    # modern static site is excluded by it.
    minimum_protocol_version = "TLSv1.2_2021"
  }
}
