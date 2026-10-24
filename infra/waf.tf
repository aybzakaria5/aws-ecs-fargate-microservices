# Optional AWS WAF in front of the ALB (var.enable_waf). Two protections:
#  1. AWS managed "common rule set" (OWASP-style: bad inputs, XSS, SQLi patterns ...)
#  2. a per-IP rate limit (1000 requests / 5 minutes) against floods and credential stuffing on /auth/login
resource "aws_wafv2_web_acl" "alb" {
  count = var.enable_waf ? 1 : 0

  name  = "${local.name}-alb-acl"
  scope = "REGIONAL"

  default_action {
    allow {}
  }

  rule {
    name     = "aws-common-rules"
    priority = 10

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name}-common-rules"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "rate-limit-per-ip"
    priority = 20

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit              = 1000
        aggregate_key_type = "IP"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name}-rate-limit"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${local.name}-alb-acl"
    sampled_requests_enabled   = true
  }
}

resource "aws_wafv2_web_acl_association" "alb" {
  count = var.enable_waf ? 1 : 0

  resource_arn = aws_lb.main.arn
  web_acl_arn  = aws_wafv2_web_acl.alb[0].arn
}
