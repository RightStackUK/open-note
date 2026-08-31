# Buying the domain through Route 53 creates the hosted zone, so this looks it
# up rather than creating one. A zone created here would get fresh name servers
# that the registrar was never told about, and the domain would resolve to
# nothing.
data "aws_route53_zone" "site" {
  name         = "${var.domain}."
  private_zone = false
}

locals {
  aliases = var.www_redirect ? [var.domain, "www.${var.domain}"] : [var.domain]
}

# In us-east-1 because CloudFront reads certificates from there and nowhere else.
resource "aws_acm_certificate" "site" {
  provider = aws.us_east_1

  domain_name               = var.domain
  subject_alternative_names = var.www_redirect ? ["www.${var.domain}"] : []
  validation_method         = "DNS"

  lifecycle {
    # ACM cannot re-point a live distribution mid-swap, so a certificate change
    # has to produce the replacement before the original is destroyed.
    create_before_destroy = true
  }
}

resource "aws_route53_record" "certificate_validation" {
  for_each = {
    for option in aws_acm_certificate.site.domain_validation_options :
    option.domain_name => {
      name   = option.resource_record_name
      record = option.resource_record_value
      type   = option.resource_record_type
    }
  }

  zone_id         = data.aws_route53_zone.site.zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 60
  allow_overwrite = true
}

# Blocks the apply until ACM has actually seen the records. Without it the
# distribution would be created with a certificate still in PENDING_VALIDATION
# and the apply would fail further down for a reason that reads as unrelated.
resource "aws_acm_certificate_validation" "site" {
  provider = aws.us_east_1

  certificate_arn         = aws_acm_certificate.site.arn
  validation_record_fqdns = [for record in aws_route53_record.certificate_validation : record.fqdn]
}

# Alias records, not CNAMEs: the apex of a zone cannot hold a CNAME, and an alias
# is resolved inside Route 53 so it costs nothing per query.
resource "aws_route53_record" "ipv4" {
  for_each = toset(local.aliases)

  zone_id = data.aws_route53_zone.site.zone_id
  name    = each.value
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.site.domain_name
    zone_id                = aws_cloudfront_distribution.site.hosted_zone_id
    evaluate_target_health = false
  }
}

# The distribution answers on IPv6, so the zone should say so. A missing AAAA
# makes an IPv6-only client fail to resolve the site at all.
resource "aws_route53_record" "ipv6" {
  for_each = toset(local.aliases)

  zone_id = data.aws_route53_zone.site.zone_id
  name    = each.value
  type    = "AAAA"

  alias {
    name                   = aws_cloudfront_distribution.site.domain_name
    zone_id                = aws_cloudfront_distribution.site.hosted_zone_id
    evaluate_target_health = false
  }
}
