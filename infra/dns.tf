# Optional custom domain: Route 53 alias record -> ALB, with a certificate issued and validated by ACM.
# Enabled when var.domain_name is set (the hosted zone must already exist: var.route53_zone_id).

locals {
  dns_enabled     = var.domain_name != ""
  certificate_arn = var.acm_certificate_arn != "" ? var.acm_certificate_arn : (local.dns_enabled ? aws_acm_certificate_validation.main[0].certificate_arn : "")
}

resource "aws_acm_certificate" "main" {
  count = local.dns_enabled && var.acm_certificate_arn == "" ? 1 : 0

  domain_name       = var.domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true

    precondition {
      condition     = var.route53_zone_id != ""
      error_message = "route53_zone_id is required when domain_name is set."
    }
  }
}

resource "aws_route53_record" "cert_validation" {
  for_each = local.dns_enabled && var.acm_certificate_arn == "" ? {
    for o in aws_acm_certificate.main[0].domain_validation_options : o.domain_name => {
      name   = o.resource_record_name
      type   = o.resource_record_type
      record = o.resource_record_value
    }
  } : {}

  zone_id         = var.route53_zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 60
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "main" {
  count = local.dns_enabled && var.acm_certificate_arn == "" ? 1 : 0

  certificate_arn         = aws_acm_certificate.main[0].arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]
}

resource "aws_route53_record" "app" {
  count = local.dns_enabled ? 1 : 0

  zone_id = var.route53_zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = aws_lb.main.dns_name
    zone_id                = aws_lb.main.zone_id
    evaluate_target_health = true
  }
}
