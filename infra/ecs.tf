resource "aws_ecs_cluster" "main" {
  name = "${local.name}-cluster"

  setting {
    name  = "containerInsights"
    value = var.enable_container_insights ? "enabled" : "disabled"
  }
}

resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name       = aws_ecs_cluster.main.name
  capacity_providers = ["FARGATE"]
}

resource "aws_cloudwatch_log_group" "svc" {
  for_each = local.services

  name              = "/ecs/${local.name}/${each.key}"
  retention_in_days = var.log_retention_days
}

resource "aws_ecs_task_definition" "svc" {
  for_each = local.services

  family                   = "${local.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task[each.key].arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([
    {
      name      = each.key
      image     = "${aws_ecr_repository.svc[each.key].repository_url}:${var.image_tag}"
      essential = true

      portMappings = [{ containerPort = var.container_port, protocol = "tcp" }]

      environment = concat(
        [
          { name = "NODE_ENV", value = "production" },
          { name = "PORT", value = tostring(var.container_port) },
        ],
        [for k, v in local.service_env[each.key] : { name = k, value = v }]
      )
      secrets = local.service_secrets[each.key]

      readonlyRootFilesystem = true
      stopTimeout            = 10

      healthCheck = {
        command     = ["CMD-SHELL", "wget -qO- http://127.0.0.1:${var.container_port}/health >/dev/null || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 10
      }

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.svc[each.key].name
          awslogs-region        = var.region
          awslogs-stream-prefix = each.key
        }
      }
    }
  ])
}

resource "aws_ecs_service" "svc" {
  for_each = local.services

  name                               = "${local.name}-${each.key}"
  cluster                            = aws_ecs_cluster.main.id
  task_definition                    = aws_ecs_task_definition.svc[each.key].arn
  desired_count                      = var.desired_count
  launch_type                        = "FARGATE"
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  health_check_grace_period_seconds  = 30
  propagate_tags                     = "SERVICE"

  deployment_circuit_breaker {
    enable   = true
    rollback = true # a bad release rolls itself back
  }

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.svc[each.key].arn
    container_name   = each.key
    container_port   = var.container_port
  }

  service_registries {
    registry_arn = aws_service_discovery_service.svc[each.key].arn
  }

  depends_on = [
    aws_lb_listener_rule.svc,
    aws_vpc_endpoint.interface,
    aws_vpc_endpoint.gateway,
    aws_iam_role_policy_attachment.execution_managed,
    aws_iam_role_policy.execution_secrets,
    aws_secretsmanager_secret_version.jwt,
  ]

  lifecycle {
    # CI/CD registers new task-definition revisions and Auto Scaling changes the count;
    # Terraform must not revert either on the next apply.
    ignore_changes = [task_definition, desired_count]
  }
}

# ---------------------------------------------------------------- Service Auto Scaling
resource "aws_appautoscaling_target" "svc" {
  for_each = local.services

  service_namespace  = "ecs"
  scalable_dimension = "ecs:service:DesiredCount"
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.svc[each.key].name}"
  min_capacity       = var.desired_count
  max_capacity       = var.max_count
}

resource "aws_appautoscaling_policy" "cpu" {
  for_each = local.services

  name               = "${local.name}-${each.key}-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.svc[each.key].service_namespace
  scalable_dimension = aws_appautoscaling_target.svc[each.key].scalable_dimension
  resource_id        = aws_appautoscaling_target.svc[each.key].resource_id

  target_tracking_scaling_policy_configuration {
    target_value       = 60
    scale_in_cooldown  = 120
    scale_out_cooldown = 60

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}

resource "aws_appautoscaling_policy" "requests" {
  for_each = local.services

  name               = "${local.name}-${each.key}-requests"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.svc[each.key].service_namespace
  scalable_dimension = aws_appautoscaling_target.svc[each.key].scalable_dimension
  resource_id        = aws_appautoscaling_target.svc[each.key].resource_id

  target_tracking_scaling_policy_configuration {
    target_value       = 500 # requests per target per minute
    scale_in_cooldown  = 120
    scale_out_cooldown = 60

    predefined_metric_specification {
      predefined_metric_type = "ALBRequestCountPerTarget"
      resource_label         = "${aws_lb.main.arn_suffix}/${aws_lb_target_group.svc[each.key].arn_suffix}"
    }
  }
}
