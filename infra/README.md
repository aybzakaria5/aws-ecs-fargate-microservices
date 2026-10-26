# Infrastructure (Terraform)

Builds everything in the architecture diagram in one region (default `us-east-1`): about 70 resources.

| File | Contents |
|---|---|
| `versions.tf` | Terraform and provider versions, AWS provider with default tags |
| `variables.tf`, `locals.tf` | Inputs; the `services` map that drives every per-service resource |
| `network.tf` | VPC, 2 public + 2 private subnets, Internet Gateway, route tables, security groups, VPC endpoints (5 interface, 2 gateway), Cloud Map namespace and services |
| `alb.tf` | Application Load Balancer, listeners (HTTP redirect + HTTPS when a certificate exists), target groups, path rules |
| `dns.tf` | Optional: ACM certificate (DNS validation) and Route 53 alias record, when `domain_name` is set |
| `waf.tf` | Optional: AWS WAF web ACL (managed common rules + per-IP rate limit) when `enable_waf = true` |
| `platform.tf` | ECR repositories, DynamoDB tables (orders, notifications), SQS queue + dead-letter queue, Secrets Manager secret |
| `iam.tf` | ECS execution role, one task role per service, least-privilege policies |
| `ecs.tf` | ECS cluster, log groups, task definitions, services, Service Auto Scaling |
| `monitoring.tf` | SNS topic and CloudWatch alarms (ALB 5xx, unhealthy targets, CPU, DLQ not empty, queue age) |
| `github_oidc.tf` | OIDC provider and deploy role for GitHub Actions (only when `github_repo` is set) |
| `outputs.tf` | ALB/app URL, ECR URLs, cluster and service names, queue URLs, deploy role ARN |

## Apply

```bash
cp terraform.tfvars.example terraform.tfvars   # edit if you want
terraform init
terraform validate
terraform plan                                  # free: shows exactly what would be created

# 1. only the ECR repositories, so images can be pushed
terraform apply -target=aws_ecr_repository.svc

# 2. first images (tag "bootstrap")
../scripts/bootstrap-images.sh

# 3. everything else
terraform apply
terraform output
```

Without `domain_name` or `acm_certificate_arn` the ALB serves plain HTTP (demo only). With a domain, Terraform requests the certificate, validates it through Route 53, creates the alias record, serves HTTPS on 443 and redirects port 80.

## Cost warning

These resources bill while they exist, even with no traffic: the five interface endpoints in two AZs, the ALB and the Fargate tasks are the main items (see [docs/cost.md](../docs/cost.md)). For a short demo use `desired_count = 1`, set an AWS Budget alert first, and run `terraform destroy` when you are done. The secret and the ECR repositories are configured to be deleted immediately on destroy. After destroying, check the console for leftover VPC endpoints, load balancers and ECS clusters.

## Notes

- The generated JWT secret is stored in Terraform state. For anything beyond a demo use a private, encrypted remote backend (`backend.tf.example`).
- `lifecycle.ignore_changes` on the ECS services is intentional: the deploy pipeline registers new task-definition revisions and Auto Scaling changes the task count.
- Run `terraform fmt -recursive` before committing.
