'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createServer } = require('../src/server');
const { memoryStore } = require('../src/store');

/** Stub of the Auth service: token "tok-alice" -> alice, "tok-bob" -> bob, anything else -> 401. */
function startFakeAuth(mode = 'ok') {
  const server = http.createServer((req, res) => {
    if (mode === 'down') return req.destroy();
    if (mode === 'error') {
      res.writeHead(500);
      return res.end('{}');
    }
    const tok = (req.headers.authorization || '').replace('Bearer ', '');
    const user = { 'tok-alice': 'alice', 'tok-bob': 'bob' }[tok];
    res.writeHead(user ? 200 : 401, { 'content-type': 'application/json' });
    res.end(JSON.stringify(user ? { user } : { error: 'invalid' }));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

async function withOrders(fn, authMode = 'ok', publisher) {
  const auth = await startFakeAuth(authMode);
  const orders = createServer({ authUrl: `http://127.0.0.1:${auth.address().port}`, store: memoryStore(), publisher });
  await new Promise((r) => orders.listen(0, '127.0.0.1', r));
  try {
    await fn(`http://127.0.0.1:${orders.address().port}`);
  } finally {
    await new Promise((r) => orders.close(r));
    await new Promise((r) => auth.close(r));
  }
}

const call = (base, path, { token, method = 'GET', body } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });

test('health does not need a token', () =>
  withOrders(async (base) => {
    const res = await call(base, '/health');
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).store, 'memory');
  }));

test('orders endpoints require a valid token', () =>
  withOrders(async (base) => {
    assert.strictEqual((await call(base, '/orders')).status, 401);
    assert.strictEqual((await call(base, '/orders', { token: 'bad' })).status, 401);
  }));

test('create, get and list an order', () =>
  withOrders(async (base) => {
    const created = await call(base, '/orders', { token: 'tok-alice', method: 'POST', body: { items: [{ sku: 'ABC', qty: 2 }] } });
    assert.strictEqual(created.status, 201);
    const order = await created.json();
    assert.strictEqual(order.userId, 'alice');
    assert.strictEqual(order.status, 'CREATED');

    const one = await call(base, `/orders/${order.orderId}`, { token: 'tok-alice' });
    assert.strictEqual(one.status, 200);
    assert.deepStrictEqual((await one.json()).items, [{ sku: 'ABC', qty: 2 }]);

    const list = await (await call(base, '/orders', { token: 'tok-alice' })).json();
    assert.strictEqual(list.count, 1);
  }));

test('users cannot read each other\'s orders', () =>
  withOrders(async (base) => {
    const order = await (await call(base, '/orders', { token: 'tok-alice', method: 'POST', body: { items: [{ sku: 'X', qty: 1 }] } })).json();
    assert.strictEqual((await call(base, `/orders/${order.orderId}`, { token: 'tok-bob' })).status, 404);
    assert.strictEqual((await (await call(base, '/orders', { token: 'tok-bob' })).json()).count, 0);
  }));

test('input validation', () =>
  withOrders(async (base) => {
    const bad = (body) => call(base, '/orders', { token: 'tok-alice', method: 'POST', body });
    assert.strictEqual((await bad({})).status, 400);
    assert.strictEqual((await bad({ items: [] })).status, 400);
    assert.strictEqual((await bad({ items: [{ sku: '', qty: 1 }] })).status, 400);
    assert.strictEqual((await bad({ items: [{ sku: 'A', qty: 0 }] })).status, 400);
    assert.strictEqual((await bad({ items: [{ sku: 'A', qty: 1.5 }] })).status, 400);
  }));

test('auth service down gives 503, auth service error gives 502', async () => {
  await withOrders(async (base) => {
    assert.strictEqual((await call(base, '/orders', { token: 'tok-alice' })).status, 503);
  }, 'down');
  await withOrders(async (base) => {
    assert.strictEqual((await call(base, '/orders', { token: 'tok-alice' })).status, 502);
  }, 'error');
});

test('server requires AUTH_URL', () => {
  assert.throws(() => createServer({}), /AUTH_URL/);
});

test('publishes an order.created event after saving the order', async () => {
  const events = [];
  const publisher = { kind: 'fake', publish: async (e) => events.push(e) };
  await withOrders(async (base) => {
    const order = await (await call(base, '/orders', { token: 'tok-alice', method: 'POST', body: { items: [{ sku: 'A', qty: 1 }, { sku: 'B', qty: 3 }] } })).json();
    assert.strictEqual(events.length, 1);
    assert.deepStrictEqual(
      { type: events[0].type, orderId: events[0].orderId, userId: events[0].userId, itemCount: events[0].itemCount },
      { type: 'order.created', orderId: order.orderId, userId: 'alice', itemCount: 2 },
    );
  }, 'ok', publisher);
});

test('a queue outage does not fail the request and the order is still saved', async () => {
  const publisher = { kind: 'fake', publish: async () => { throw new Error('queue down'); } };
  await withOrders(async (base) => {
    const res = await call(base, '/orders', { token: 'tok-alice', method: 'POST', body: { items: [{ sku: 'A', qty: 1 }] } });
    assert.strictEqual(res.status, 201);
    assert.strictEqual((await (await call(base, '/orders', { token: 'tok-alice' })).json()).count, 1);
  }, 'ok', publisher);
});

test('no event is published for rejected or invalid requests', async () => {
  const events = [];
  const publisher = { kind: 'fake', publish: async (e) => events.push(e) };
  await withOrders(async (base) => {
    await call(base, '/orders', { method: 'POST', body: { items: [{ sku: 'A', qty: 1 }] } }); // no token
    await call(base, '/orders', { token: 'tok-alice', method: 'POST', body: { items: [] } }); // invalid
    assert.strictEqual(events.length, 0);
  }, 'ok', publisher);
});
