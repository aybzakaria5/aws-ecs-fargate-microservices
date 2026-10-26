# Run it locally

Back to the [README](../README.md).

Requirements: Docker (or Node.js 20+ for the unit tests).

```bash
docker compose up --build

# log in as a demo user
TOKEN=$(curl -s -X POST localhost:3001/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"alice","password":"alice-demo-pw"}' | jq -r .token)

# create an order: Orders verifies the token with Auth, saves the order, publishes an event
curl -s -X POST localhost:3002/orders -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"items":[{"sku":"BOOK-1","qty":2}]}'

# a few seconds later Notifications has consumed the event
curl -s localhost:3003/notifications -H "authorization: Bearer $TOKEN"
```

Ports: 3001 Auth, 3002 Orders, 3003 Notifications, 9324 the local queue. Locally both services use in-memory stores; in AWS they use DynamoDB.

Unit tests:

```bash
cd services/auth && npm test
cd services/orders && npm ci && npm test
cd services/notifications && npm ci && npm test
```

## API summary

| Method and path | Service | Auth | Purpose |
|---|---|---|---|
| `POST /auth/login` | Auth | none | `{username, password}` returns `{token, expiresIn}` |
| `GET /auth/verify` | Auth | Bearer | Returns the user the token belongs to |
| `POST /orders` | Orders | Bearer | `{items:[{sku, qty}]}` creates an order and publishes `order.created` |
| `GET /orders`, `GET /orders/{id}` | Orders | Bearer | The caller's orders |
| `GET /notifications` | Notifications | Bearer | The caller's notifications, newest first |
| `GET /health` | each task | none | Used by the ALB and ECS health checks (not routed by the ALB) |
