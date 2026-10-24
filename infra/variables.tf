variable "region" {
  description = "AWS region"
  type        = string
  default     = "us-east-1"
}

variable "project" {
  description = "Short project name used as a prefix for resource names"
  type        = string
  default     = "msvc"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,11}$", var.project))
    error_message = "project must be 2-12 chars: lowercase letters, digits and hyphens, starting with a letter."
  }
}

variable "environment" {
  description = "Environment name (demo, dev, prod ...)"
  type        = string
  default     = "demo"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,9}$", var.environment))
    error_message = "environment must be 2-10 chars: lowercase letters, digits and hyphens."
  }
}

variable "vpc_cidr" {
  description = "CIDR block of the VPC"
  type        = string
  default     = "10.0.0.0/16"
}

variable "public_subnet_cidrs" {
  description = "Public subnets (ALB), one per Availability Zone"
  type        = list(string)
  default     = ["10.0.1.0/24", "10.0.2.0/24"]

  validation {
    condition     = length(var.public_subnet_cidrs) == 2
    error_message = "Exactly two public subnets are expected (two Availability Zones)."
  }
}

variable "private_subnet_cidrs" {
  description = "Private subnets (Fargate tasks, VPC endpoints), one per Availability Zone"
  type        = list(string)
  default     = ["10.0.11.0/24", "10.0.12.0/24"]

  validation {
    condition     = length(var.private_subnet_cidrs) == 2
    error_message = "Exactly two private subnets are expected (two Availability Zones)."
  }
}

variable "service_namespace" {
  description = "Private DNS namespace created in AWS Cloud Map"
  type        = string
  default     = "services.local"
}

variable "container_port" {
  description = "Port every service container listens on"
  type        = number
  default     = 3000
}

variable "task_cpu" {
  description = "Fargate task CPU units (256 = 0.25 vCPU)"
  type        = number
  default     = 256
}

variable "task_memory" {
  description = "Fargate task memory in MiB (512 is valid with 256 CPU)"
  type        = number
  default     = 512
}

variable "desired_count" {
  description = "Tasks per service (also the Auto Scaling minimum). 2 = one per AZ. Use 1 for a cheap demo."
  type        = number
  default     = 2

  validation {
    condition     = var.desired_count >= 1
    error_message = "desired_count must be at least 1."
  }
}

variable "max_count" {
  description = "Auto Scaling maximum tasks per service"
  type        = number
  default     = 4
}

variable "image_tag" {
  description = "Image tag used by the task definitions Terraform creates. CI/CD later registers newer revisions with commit-SHA tags."
  type        = string
  default     = "bootstrap"
}

variable "acm_certificate_arn" {
  description = "Existing ACM certificate ARN for HTTPS on the ALB. Leave empty to use domain_name (below) or plain HTTP (demo only)."
  type        = string
  default     = ""
}

variable "domain_name" {
  description = "Public DNS name for the application (for example api.example.com). When set together with route53_zone_id, Terraform requests an ACM certificate (DNS validation) and creates the Route 53 alias record to the ALB."
  type        = string
  default     = ""
}

variable "route53_zone_id" {
  description = "ID of the existing Route 53 public hosted zone that contains domain_name"
  type        = string
  default     = ""
}

variable "enable_waf" {
  description = "Attach an AWS WAF web ACL (AWS managed common rules + a per-IP rate limit) to the ALB. Adds a monthly cost."
  type        = bool
  default     = false
}

variable "queue_max_receive_count" {
  description = "How many times SQS delivers a message before moving it to the dead-letter queue"
  type        = number
  default     = 5
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention"
  type        = number
  default     = 14
}

variable "ecr_images_to_keep" {
  description = "Number of images kept per ECR repository (older ones expire)"
  type        = number
  default     = 10
}

variable "enable_container_insights" {
  description = "Enable ECS Container Insights (extra CloudWatch cost)"
  type        = bool
  default     = false
}

variable "alarm_email" {
  description = "E-mail address subscribed to the alarm SNS topic (leave empty to skip the subscription)"
  type        = string
  default     = ""
}

variable "github_repo" {
  description = "GitHub repository (owner/name) allowed to deploy through OIDC. Leave empty to skip creating the deploy role."
  type        = string
  default     = ""

  validation {
    condition     = var.github_repo == "" || can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repo))
    error_message = "github_repo must look like owner/name."
  }
}
