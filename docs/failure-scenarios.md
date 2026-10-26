# What happens when something fails

How the design behaves for each kind of failure, and why that is acceptable. Back to the [README](../README.md).

| Failure | What happens | Why that is acceptable |
|---|---|---|
| A container crashes or stops answering | The ALB stops sending it traffic after 3 failed health checks (15 s apart) and ECS starts a replacement. The other task keeps serving. | Two tasks per service |
| An entire Availability Zone is lost | The ALB sends all traffic to the tasks in the other AZ; ECS launches replacements there; Auto Scaling adds capacity if CPU or request rate rises. | Each service has a task in each AZ |
| Auth is down | Orders and Notifications return `503` for authenticated calls (they fail closed). Events already in the queue still get processed, because the consumer does not call Auth. | Secure default; the dependency is visible |
| Notifications is down or slow | Orders is unaffected. Events wait in the queue (kept for 4 days). The "oldest message older than 5 minutes" alarm fires. When Notifications recovers it drains the backlog. | This is the reason for the queue |
| A message cannot be processed (a bug or bad data) | It is retried (the visibility timeout is 60 s); after 5 attempts SQS moves it to the dead-letter queue and the DLQ alarm fires. Messages stay there 14 days for inspection and redrive. | No silent loss, no infinite loop |
| A message is delivered twice | The notification id is derived from the order id, so the second write overwrites the first. | At-least-once delivery is handled |
| A bad release is deployed | New tasks fail their health checks, the deployment circuit breaker trips and ECS rolls back to the previous task definition. | Failed releases do not take the service down |
| Traffic spikes | Target-tracking Auto Scaling adds tasks (CPU at 60% or 500 requests per target per minute); DynamoDB on-demand and SQS scale on their own. | Capacity follows load |
| The SQS publish fails after the order was saved | The order is kept and the error is logged; the notification for it is lost. See "Limitations" in the README. | Known trade-off, with the fix described |
| The whole region is unavailable | Not covered. The environment can be recreated in another region with Terraform, but data is not replicated. | Out of scope for the stated requirements |
