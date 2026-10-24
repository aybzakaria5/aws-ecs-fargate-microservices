data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# ---------------------------------------------------------------- execution role
# Used by the ECS agent (not by your code): pull images from ECR, write logs, read the secret it injects.
resource "aws_iam_role" "execution" {
  name               = "${local.name}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution_secrets" {
  statement {
    sid       = "ReadInjectedSecrets"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.jwt.arn]
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  name   = "read-injected-secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_secrets.json
}

# ---------------------------------------------------------------- task roles (one per service, least privilege)
resource "aws_iam_role" "task" {
  for_each = local.services

  name               = "${local.name}-task-${each.key}"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

# Only Orders touches DynamoDB, and only the actions it uses on its own table.
data "aws_iam_policy_document" "orders_dynamodb" {
  statement {
    sid       = "OrdersTableAccess"
    actions   = ["dynamodb:PutItem", "dynamodb:GetItem", "dynamodb:Query"]
    resources = [aws_dynamodb_table.orders.arn]
  }
}

resource "aws_iam_role_policy" "orders_dynamodb" {
  name   = "orders-table-access"
  role   = aws_iam_role.task["orders"].id
  policy = data.aws_iam_policy_document.orders_dynamodb.json
}

# Orders may only send messages to the order-events queue.
data "aws_iam_policy_document" "orders_sqs" {
  statement {
    sid       = "PublishOrderEvents"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.order_events.arn]
  }
}

resource "aws_iam_role_policy" "orders_sqs" {
  name   = "orders-publish-events"
  role   = aws_iam_role.task["orders"].id
  policy = data.aws_iam_policy_document.orders_sqs.json
}

# Notifications may only consume that queue and write to its own table.
data "aws_iam_policy_document" "notifications_access" {
  statement {
    sid = "ConsumeOrderEvents"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:ChangeMessageVisibility",
      "sqs:GetQueueAttributes",
    ]
    resources = [aws_sqs_queue.order_events.arn]
  }

  statement {
    sid       = "NotificationsTableAccess"
    actions   = ["dynamodb:PutItem", "dynamodb:Query"]
    resources = [aws_dynamodb_table.notifications.arn]
  }
}

resource "aws_iam_role_policy" "notifications_access" {
  name   = "notifications-consume-and-store"
  role   = aws_iam_role.task["notifications"].id
  policy = data.aws_iam_policy_document.notifications_access.json
}
