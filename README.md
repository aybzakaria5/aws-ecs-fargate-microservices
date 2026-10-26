# Containerized Microservices on Amazon ECS Fargate

A highly available, secure and loosely coupled microservices platform on AWS, built on Amazon ECS Fargate and designed against the AWS Well-Architected Framework. The repository holds the architecture and the reasoning behind it, a small working implementation of three services, the Terraform that builds the environment, and the GitHub Actions pipelines that test and deploy it.

## 1. Overview

**Problem.** A monolithic Node.js application is hard to run as one unit: one bug can take everything down, everything is scaled and released together, and every component shares the same permissions and secrets.

**Solution.** Three independently deployable services running as containers on ECS Fargate, with no servers to manage:

| Service | Responsibility | State |
|---|---|---|
| **Auth** | Issues and verifies JWTs | None (signing key from Secrets Manager) |
| **Orders** | Creates and reads a user's orders; announces each new order as an event | DynamoDB table |
| **Notifications** | Turns order events into notifications; lists the caller's notifications | DynamoDB table |

**Design goals** that drove every choice below:

- Survive the loss of a container or a whole Availability Zone without manual action.
- Expose only the load balancer to the internet; give every service the minimum permissions it needs.
- A slow or failing downstream service must not break the customer's request.
- Repeatable, reversible releases; cost that follows usage.

The services talk to each other in two ways, chosen on purpose: **synchronously over HTTP** when the caller needs the answer now (Orders asks Auth "who is this token?"), and **asynchronously through SQS** when it does not (Orders announces "an order was created" and moves on).

> The infrastructure, networking, IAM model, pipeline and messaging pattern are built as I would build a first production version. The application logic is intentionally small (see [limitations](#6-limitations-and-next-steps)).

## 2. Architecture diagram

![Architecture](docs/architecture.png)

Editable source: [`docs/architecture.drawio`](docs/architecture.drawio) (open at [app.diagrams.net](https://app.diagrams.net)). The numbered badges match the steps below.

## 3. How it works

**Request flow**

1. A user resolves the domain in **Route 53** and connects over HTTPS: **Internet Gateway**, optional **WAF**, then the **Application Load Balancer** in the public subnets (certificate from **ACM**).
2. The ALB routes by path (`/auth/*`, `/orders/*`, `/notifications/*`) to **Fargate tasks in private subnets** across two Availability Zones. Only tasks that pass `GET /health` receive traffic.
3. Orders and Notifications verify each token with Auth at `auth.services.local`, a name registered in **AWS Cloud Map**.
4. Orders and Notifications read and write their **DynamoDB** tables through a gateway VPC endpoint.

**Event flow**

5. After saving an order, Orders publishes an `order.created` message to **SQS** (through a VPC endpoint) and answers `201` without waiting.
6. Notifications consumes the queue at its own pace, stores the notification, and deletes the message only after it is saved. A message that keeps failing moves to a **dead-letter queue** and raises an alarm.

**Platform flow**

7. At start-up ECS injects the JWT signing key from **Secrets Manager** into the Auth container only.
8. Fargate pulls images from **ECR** (scan on push) through VPC endpoints.
9. Logs go to **CloudWatch Logs**; CloudWatch alarms watch 5xx errors, unhealthy targets, CPU, queue age and the dead-letter queue.
10. **GitHub Actions** builds each image, pushes it to ECR tagged with the commit SHA and updates the ECS service, authenticating to AWS with short-lived OIDC credentials (no stored keys).

## 4. Design decisions

| Decision | Why | Alternative considered |
|---|---|---|
| **ECS on Fargate** | No instances to patch, per-task IAM roles and networking, pay for what tasks use | *EKS*: more than three services need, plus a control-plane fee and cluster upgrades. *Lambda*: great for spiky low traffic, but the goal here is container microservices. |
| **Two AZs, one task per service per AZ** | Survives an AZ failure with no manual action | *One AZ*: a single point of failure. *Three AZs*: more resilience for 50% more baseline cost. |
| **Private subnets and VPC endpoints, no NAT Gateway** | Tasks never need the internet, so they get no route to it. AWS API traffic stays on the AWS network. | *NAT Gateway*: cheaper for a tiny environment, but gives tasks general internet access ([cost trade-off](docs/cost.md)). |
| **ALB with path-based rules** | One public entry point with health checks, TLS, WAF and ECS integration | *API Gateway*: useful for API keys and per-client throttling, which are not needed here. |
| **Cloud Map for service-to-service calls** | ECS registers and deregisters task IPs automatically; no extra load balancer to pay for | *Internal ALB*: an extra hop and cost per service. *ECS Service Connect*: richer, and the next step if retries and per-connection metrics are needed. |
| **SQS between Orders and Notifications** | Orders does not wait for, or depend on, Notifications. The queue absorbs bursts and keeps messages 4 days if the consumer is down. | *Direct HTTP call*: a Notifications outage would break order creation. *SNS fan-out*: the right step once a second consumer appears. |
| **Dead-letter queue and idempotent consumer** | SQS delivers at least once: after 5 failed attempts a message is parked for 14 days with an alarm, and a duplicate delivery overwrites the same item instead of creating a second notification | *No DLQ*: poison messages loop or vanish silently. |
| **DynamoDB (on-demand)** | Access is always "by user": key-value, no joins. Multi-AZ, no capacity planning, point-in-time recovery. | *RDS/Aurora*: better for ad-hoc queries and reporting across users. |
| **Secrets Manager injected by ECS** | The signing key is never in an image, the repository or the task definition | *Plain environment variables*: the secret would sit in clear text in the task definition. |
| **Own Auth service** | Demonstrates service-to-service authentication, discovery and failure handling | *Amazon Cognito*: what I would use for real users (sign-up, MFA, federation). |
| **Terraform and GitHub Actions with OIDC** | Reviewable, repeatable, destroyable infrastructure; no long-lived AWS keys; deploy role usable only from `main` of this repository | *CodePipeline/CodeDeploy*: AWS-native and supports blue/green, with more services to configure. |
| **Rolling deployment with circuit breaker** | New tasks must pass health checks first; a failing release rolls back automatically | *Blue/green*: safer traffic shifting, more moving parts. |

## 5. Security and Well-Architected alignment

**Network.** Public subnets hold only the ALB. Private subnets have no route to the internet; AWS services are reached through interface endpoints (ECR, CloudWatch Logs, Secrets Manager, SQS) and gateway endpoints (S3, DynamoDB). Security groups allow only: Internet to ALB (80/443), ALB to tasks (3000), tasks to tasks (3000), tasks to the endpoints (443).

**Identity.** One IAM task role per service: Auth has no AWS permissions; Orders can only write to its table and send to the queue; Notifications can only consume the queue and write to its table. The GitHub deploy role can only push to the three ECR repositories and update the three services.

| Pillar | How the design addresses it |
|---|---|
| **Operational Excellence** | All infrastructure is Terraform; CI runs tests, image smoke tests and `terraform validate` on every pull request; JSON logs, alarms, graceful shutdown on `SIGTERM`. |
| **Security** | Private tasks, least-privilege roles, secrets in Secrets Manager, non-root read-only containers, immutable image tags, scan on push, encryption in transit (TLS) and at rest, OIDC instead of stored keys, optional WAF with a rate limit. |
| **Reliability** | Two AZs, health checks, self-healing services, automatic rollback, Auto Scaling, SQS retries with a dead-letter queue, multi-AZ DynamoDB with point-in-time recovery. [Failure scenarios](docs/failure-scenarios.md) walks through each case. |
| **Performance Efficiency** | Right-sized tasks, target-tracking Auto Scaling on CPU and request count, on-demand DynamoDB and SQS, long polling. |
| **Cost Optimization** | Pay-per-use compute and data stores, log retention and image lifecycle policies, a single setting (`desired_count`) to run a cheap one-task demo. The most expensive choices and how to reduce them are in [docs/cost.md](docs/cost.md). |
| **Sustainability** | Serverless compute and scale-in avoid idle capacity; one region and right-sized tasks keep the footprint small. |

## 6. Limitations and next steps

- **Dual write.** Orders saves the order and then publishes the event; if the publish fails, the order exists but no notification is created. The robust fix is the transactional outbox pattern, or DynamoDB Streams feeding EventBridge Pipes into SQS.
- **Demo identity and delivery.** Auth uses a fixed list of demo users (a real system would use Cognito) and "sending" a notification means storing and logging it (a real one would call SNS or SES).
- **Single region.** DynamoDB global tables and a second environment would add disaster recovery.
- **More observability and safer releases.** Tracing (X-Ray/OpenTelemetry), ALB access logs, blue/green with CodeDeploy, WAF enabled by default.

## 7. Repository structure

```
.
├── README.md
├── docker-compose.yml        # run everything locally (ElasticMQ stands in for SQS)
├── docs/                     # diagram, failure scenarios, cost, running locally
├── services/                 # auth, orders, notifications (Node.js 22; src/, test/, Dockerfile)
├── infra/                    # Terraform (see infra/README.md)
├── scripts/bootstrap-images.sh
└── .github/workflows/        # ci.yml (tests, smoke tests, terraform validate), deploy.yml
```

## 8. Run and deploy

- **Locally:** `docker compose up --build`, then follow [docs/running-locally.md](docs/running-locally.md) (login, create an order, read the notification, API summary).
- **On AWS:** [`infra/README.md`](infra/README.md) has the steps and variables (create the ECR repositories, push the first images, `terraform apply`, test through the ALB, `terraform destroy`). Optional variables: `domain_name` + `route53_zone_id` (HTTPS with ACM), `enable_waf`, `alarm_email`, `github_repo` (deploy role), `desired_count`.
- **CI/CD:** `ci.yml` runs on every pull request and push. `deploy.yml` runs on pushes to `main` that change `services/` and is skipped until the repository variable `AWS_ROLE_ARN` is set, so the repository stays green when it is documented but not deployed. After the first deployment Terraform ignores later changes to each service's task definition and desired count, so `terraform apply` never rolls back a release or fights Auto Scaling.

## Author

Ayoub Zakarya
