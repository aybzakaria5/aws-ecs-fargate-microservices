output "alb_dns_name" {
  description = "Public DNS name of the Application Load Balancer"
  value       = aws_lb.main.dns_name
}

output "app_url" {
  description = "Base URL of the application"
  value       = "${local.https_enabled ? "https" : "http"}://${local.dns_enabled ? var.domain_name : aws_lb.main.dns_name}"
}

output "ecr_repository_urls" {
  description = "Repository URL per service"
  value       = { for k, r in aws_ecr_repository.svc : k => r.repository_url }
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "ecs_service_names" {
  value = { for k, s in aws_ecs_service.svc : k => s.name }
}

output "service_discovery_names" {
  description = "DNS names services use to find each other"
  value       = { for k, _ in local.services : k => "${k}.${var.service_namespace}" }
}

output "github_deploy_role_arn" {
  description = "Put this in the GitHub repository variable AWS_ROLE_ARN"
  value       = local.github_enabled ? aws_iam_role.github_deploy[0].arn : null
}

output "order_events_queue_url" {
  description = "SQS queue Orders publishes to and Notifications consumes from"
  value       = aws_sqs_queue.order_events.url
}

output "order_events_dlq_url" {
  description = "Dead-letter queue: inspect it when the DLQ alarm fires"
  value       = aws_sqs_queue.order_events_dlq.url
}
