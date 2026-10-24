'use strict';
/**
 * Notifications service
 *   GET /notifications   (Bearer token) -> the caller's notifications, newest first
 *   GET /health          liveness / ALB health check
 *
 * Notifications are NOT created through the API. Orders publishes "order.created" events to SQS and this
 * service consumes them in the background (src/consumer.js), so the two services are decoupled:
 * Orders keeps working if Notifications is down, and the queue absorbs bursts.
 */
const http = require('node:http');
const { createStore } = require('./store');
const { createQueue } = require('./queue');
const { createConsumer } = require('./consumer');
const { createEventHandler } = require('./handler');

function log(level, msg, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, service: 'notifications', msg, ...extra }));
}

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

/** Ask the Auth service who the caller is. Returns the user name, or throws with an HTTP status. */
async function authenticate(req, authUrl) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) throw Object.assign(new Error('missing bearer token'), { status: 401 });
  let resp;
  try {
    resp = await fetch(`${authUrl}/auth/verify`, { headers: { authorization: header }, signal: AbortSignal.timeout(2000) });
  } catch (err) {
    log('error', 'auth service unreachable', { error: err.message });
    throw Object.assign(new Error('auth service unavailable'), { status: 503 });
  }
  if (resp.status === 401) throw Object.assign(new Error('invalid or expired token'), { status: 401 });
  if (!resp.ok) throw Object.assign(new Error('auth service error'), { status: 502 });
  return (await resp.json()).user;
}

function createServer({ authUrl, store = createStore(), consumerState = 'disabled' } = {}) {
  if (!authUrl) throw new Error('AUTH_URL is required');
  const base = authUrl.replace(/\/+$/, '');

  return http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        return send(res, 200, { status: 'ok', service: 'notifications', store: store.kind, consumer: consumerState });
      }

      if (req.method === 'GET' && url.pathname === '/notifications') {
        const user = await authenticate(req, base);
        const items = await store.list(user);
        return send(res, 200, { count: items.length, items });
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
  const queue = createQueue();
  const consumer = queue ? createConsumer({ queue, handle: createEventHandler({ store, log }), log }) : null;

  const server = createServer({ authUrl, store, consumerState: consumer ? 'running' : 'disabled' });
  server.listen(port, '0.0.0.0', () =>
    log('info', 'listening', { port, authUrl, store: store.kind, consumer: consumer ? 'running' : 'disabled' }),
  );
  if (consumer) consumer.start();

  // Fargate sends SIGTERM on deployments / scale-in: stop polling, finish in-flight requests.
  process.on('SIGTERM', () => {
    log('info', 'SIGTERM received, shutting down');
    if (consumer) consumer.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 8000).unref();
  });
}
