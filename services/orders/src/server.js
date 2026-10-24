'use strict';
/**
 * Orders service
 *   POST /orders       { items: [{ sku, qty }] }  (Bearer token) -> 201 order
 *   GET  /orders                                  (Bearer token) -> the caller's orders
 *   GET  /orders/:id                              (Bearer token) -> one order
 *   GET  /health       liveness / ALB health check
 *
 * Every /orders call is authenticated by calling the Auth service. In AWS the URL is
 * http://auth.services.local:3000, resolved by AWS Cloud Map (private DNS) from inside the VPC.
 * After saving an order the service publishes an "order.created" event to SQS (see events.js).
 */
const http = require('node:http');
const crypto = require('node:crypto');
const { createStore } = require('./store');
const { createPublisher, noopPublisher } = require('./events');

function log(level, msg, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, service: 'orders', msg, ...extra }));
}

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function readJson(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {});
      } catch {
        reject(Object.assign(new Error('invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function validateItems(items) {
  if (!Array.isArray(items) || items.length === 0 || items.length > 50) return null;
  const clean = [];
  for (const it of items) {
    if (!it || typeof it.sku !== 'string' || !it.sku.trim()) return null;
    if (!Number.isInteger(it.qty) || it.qty < 1 || it.qty > 1000) return null;
    clean.push({ sku: it.sku.trim(), qty: it.qty });
  }
  return clean;
}

/** Ask the Auth service who the caller is. Returns the user name, or throws with an HTTP status. */
async function authenticate(req, authUrl) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) throw Object.assign(new Error('missing bearer token'), { status: 401 });
  let resp;
  try {
    resp = await fetch(`${authUrl}/auth/verify`, {
      headers: { authorization: header },
      signal: AbortSignal.timeout(2000),
    });
  } catch (err) {
    log('error', 'auth service unreachable', { error: err.message });
    throw Object.assign(new Error('auth service unavailable'), { status: 503 });
  }
  if (resp.status === 401) throw Object.assign(new Error('invalid or expired token'), { status: 401 });
  if (!resp.ok) throw Object.assign(new Error('auth service error'), { status: 502 });
  return (await resp.json()).user;
}

function createServer({ authUrl, store = createStore(), publisher = noopPublisher() } = {}) {
  if (!authUrl) throw new Error('AUTH_URL is required');
  const base = authUrl.replace(/\/+$/, '');

  return http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        return send(res, 200, { status: 'ok', service: 'orders', store: store.kind, events: publisher.kind });
      }

      const isOrders = url.pathname === '/orders' || url.pathname.startsWith('/orders/');
      if (!isOrders) return send(res, 404, { error: 'not found' });

      const user = await authenticate(req, base);

      if (req.method === 'POST' && url.pathname === '/orders') {
        const { items } = await readJson(req);
        const clean = validateItems(items);
        if (!clean) return send(res, 400, { error: '"items" must be 1-50 entries of { sku: string, qty: integer 1-1000 }' });
        const order = {
          userId: user,
          orderId: crypto.randomUUID(),
          items: clean,
          status: 'CREATED',
          createdAt: new Date().toISOString(),
        };
        await store.put(order);
        log('info', 'order created', { orderId: order.orderId, user });

        // Tell the rest of the system, asynchronously. The order is already saved, so a queue outage must
        // not fail the customer's request. The failure is logged, and the known trade-off (this is a "dual
        // write") is described in the README together with the outbox / DynamoDB Streams alternative.
        try {
          await publisher.publish({
            type: 'order.created',
            orderId: order.orderId,
            userId: order.userId,
            itemCount: order.items.length,
            createdAt: order.createdAt,
          });
        } catch (err) {
          log('error', 'failed to publish order.created', { orderId: order.orderId, error: err.message });
        }
        return send(res, 201, order);
      }

      if (req.method === 'GET' && url.pathname === '/orders') {
        const orders = await store.list(user);
        return send(res, 200, { count: orders.length, items: orders });
      }

      const m = url.pathname.match(/^\/orders\/([0-9a-fA-F-]{36})$/);
      if (req.method === 'GET' && m) {
        const order = await store.get(user, m[1]);
        return order ? send(res, 200, order) : send(res, 404, { error: 'order not found' });
      }

      return send(res, 404, { error: 'not found' });
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) log('error', 'unhandled error', { error: err.message });
      return send(res, status, { error: status === 500 ? 'internal error' : err.message });
    } finally {
      if (url.pathname !== '/health') {
        log('info', 'request', { method: req.method, path: url.pathname, status: res.statusCode, ms: Date.now() - started });
      }
    }
  });
}

module.exports = { createServer };

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  const authUrl = process.env.AUTH_URL || 'http://auth.services.local:3000';
  const store = createStore();
  const publisher = createPublisher();
  const server = createServer({ authUrl, store, publisher });
  server.listen(port, '0.0.0.0', () => log('info', 'listening', { port, authUrl, store: store.kind, events: publisher.kind }));
  process.on('SIGTERM', () => {
    log('info', 'SIGTERM received, shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 8000).unref();
  });
}
