data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  name = "${var.project}-${var.environment}"
  azs  = slice(data.aws_availability_zones.available.names, 0, 2)

  # HTTPS is on when a certificate is supplied, or when a domain name is given (then ACM issues one, see dns.tf).
  https_enabled = var.acm_certificate_arn != "" || var.domain_name != ""

  # One entry per microservice. Add a service here and every resource below picks it up.
  services = {
    auth = {
      priority      = 10
      path_patterns = ["/auth", "/auth/*"]
    }
    orders = {
      priority      = 20
      path_patterns = ["/orders", "/orders/*"]
    }
    notifications = {
      priority      = 30
      path_patterns = ["/notifications", "/notifications/*"]
    }
  }

  auth_url = "http://auth.${var.service_namespace}:${var.container_port}" # Cloud Map DNS name

  # Plain environment variables per service
  service_env = {
    auth = {}
    orders = {
      AUTH_URL               = local.auth_url
      DYNAMODB_TABLE         = aws_dynamodb_table.orders.name
      ORDER_EVENTS_QUEUE_URL = aws_sqs_queue.order_events.url
      AWS_REGION             = var.region
    }
    notifications = {
      AUTH_URL               = local.auth_url
      NOTIFICATIONS_TABLE    = aws_dynamodb_table.notifications.name
      ORDER_EVENTS_QUEUE_URL = aws_sqs_queue.order_events.url
      AWS_REGION             = var.region
    }
  }

  # Secrets injected by ECS from Secrets Manager at task start
  service_secrets = {
    auth = [
      { name = "JWT_SECRET", valueFrom = aws_secretsmanager_secret.jwt.arn },
    ]
    orders        = []
    notifications = []
  }
}
