# Cost

Back to the [README](../README.md).

Approximate **on-demand list prices in us-east-1**, running **24/7** with the defaults (2 tasks per service, 6 tasks). Treat them as an order of magnitude and check the [AWS Pricing Calculator](https://calculator.aws/) for current numbers.

| Item | Approx. per month |
|---|---|
| Fargate: 6 tasks of 0.25 vCPU / 0.5 GB | about $185 |
| Interface VPC endpoints: 5 endpoints x 2 AZs | about $73 |
| Application Load Balancer | about $22 |
| CloudWatch alarms, logs, SQS, DynamoDB on-demand, Secrets Manager, Route 53 zone | a few dollars at low traffic |
| AWS WAF, if enabled | about $8 |

How to bring it down: `desired_count = 1` halves the Fargate line; a **NAT Gateway instead of the endpoints** (one NAT costs about $33 plus data) is cheaper for a small environment, at the price of giving tasks internet access; and the whole stack can be destroyed when it is not needed (`terraform destroy`). This design deliberately favours isolation over the lowest bill.
