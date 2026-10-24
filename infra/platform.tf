# ---------------------------------------------------------------- ECR (one private repository per service)
resource "aws_ecr_repository" "svc" {
  for_each = local.services

  name                 = "${local.name}/${each.key}"
  image_tag_mutability = "IMMUTABLE" # a tag always means the same image (CI tags with the commit SHA)
  force_delete         = true        # demo: lets `terraform destroy` remove repositories that still hold images

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }
}

resource "aws_ecr_lifecycle_policy" "svc" {
  for_each   = aws_ecr_repository.svc
  repository = each.value.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last ${var.ecr_images_to_keep} images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = var.ecr_images_to_keep
      }
      action = { type = "expire" }
    }]
  })
}

# ---------------------------------------------------------------- DynamoDB (Orders)
resource "aws_dynamodb_table" "orders" {
  name         = "${local.name}-orders"
  billing_mode = "PAY_PER_REQUEST" # on-demand: no idle capacity to pay for
  hash_key     = "userId"
  range_key    = "orderId"

  attribute {
    name = "userId"
    type = "S"
  }

  attribute {
    name = "orderId"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled = true # AWS managed KMS key
  }
}

# ---------------------------------------------------------------- Secrets Manager
resource "random_password" "jwt" {
  length  = 48
  special = false
}

resource "aws_secretsmanager_secret" "jwt" {
  name                    = "${local.name}/jwt-secret"
  description             = "HS256 signing key used by the Auth service"
  recovery_window_in_days = 0 # demo: delete immediately on destroy; use 7-30 in production
}

resource "aws_secretsmanager_secret_version" "jwt" {
  secret_id     = aws_secretsmanager_secret.jwt.id
  secret_string = random_password.jwt.result
}

resource "aws_dynamodb_table" "notifications" {
  name         = "${local.name}-notifications"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "userId"
  range_key    = "notificationId"

  attribute {
    name = "userId"
    type = "S"
  }

  attribute {
    name = "notificationId"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled = true
  }
}

# ---------------------------------------------------------------- SQS (Orders -> Notifications)
# Orders publishes "order.created" events; Notifications consumes them. A message that fails
# var.queue_max_receive_count times is moved to the dead-letter queue and raises an alarm (monitoring.tf).
resource "aws_sqs_queue" "order_events_dlq" {
  name                      = "${local.name}-order-events-dlq"
  message_retention_seconds = 1209600 # 14 days to investigate failed messages
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "order_events" {
  name                       = "${local.name}-order-events"
  visibility_timeout_seconds = 60
  receive_wait_time_seconds  = 20     # long polling
  message_retention_seconds  = 345600 # 4 days
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.order_events_dlq.arn
    maxReceiveCount     = var.queue_max_receive_count
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "order_events_dlq" {
  queue_url = aws_sqs_queue.order_events_dlq.id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.order_events.arn]
  })
}
