'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createServer } = require('../src/server');
const { memoryStore } = require('../src/store');
const { createConsumer } = require('../src/consumer');
const { createEventHandler } = require('../src/handler');

const quiet = () => {};

/** Stub of the Auth service: "tok-alice" -> alice, "tok-bob" -> bob, anything else -> 401. */
function startFakeAuth(mode = 'ok') {
  const server = http.createServer((req, res) => {
    if (mode === 'down') return req.destroy();
    const tok = (req.headers.authorization || '').replace('Bearer ', '');
    const user = { 'tok-alice': 'alice', 'tok-bob': 'bob' }[tok];
    res.writeHead(user ? 200 : 401, { 'content-type': 'application/json' });
    res.end(JSON.stringify(user ? { user } : { error: 'invalid' }));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

async function withApi(fn, { store = memoryStore(), authMode = 'ok' } = {}) {
  const auth = await startFakeAuth(authMode);
  const api = createServer({ authUrl: `http://127.0.0.1:${auth.address().port}`, store });
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  try {
    await fn(`http://127.0.0.1:${api.address().port}`, store);
  } finally {
    await new Promise((r) => api.close(r));
    await new Promise((r) => auth.close(r));
  }
}

const get = (base, path, token) => fetch(`${base}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

/** In-memory fake of the queue adapter. */
function fakeQueue(bodies) {
  const pending = bodies.map((body, i) => ({ id: `m${i}`, body, handle: `h${i}` }));
  const removed = [];
  return {
    removed,
    receive: async () => pending.splice(0, 10),
    remove: async (h) => removed.push(h),
  };
}

const orderEvent = (orderId, userId = 'alice') =>
  JSON.stringify({ type: 'order.created', orderId, userId, itemCount: 2, createdAt: '2026-01-01T00:00:00Z' });

// ---------------------------------------------------------------- HTTP API
test('health does not need a token', () =>
  withApi(async (base) => {
    const res = await get(base, '/health');
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.service, 'notifications');
    assert.strictEqual(body.store, 'memory');
  }));

test('GET /notifications requires a valid token', () =>
  withApi(async (base) => {
    assert.strictEqual((await get(base, '/notifications')).status, 401);
    assert.strictEqual((await get(base, '/notifications', 'bad')).status, 401);
  }));

test('auth service down gives 503', () =>
  withApi(
    async (base) => {
      assert.strictEqual((await get(base, '/notifications', 'tok-alice')).status, 503);
    },
    { authMode: 'down' },
  ));

test('each user only sees their own notifications, newest first', () =>
  withApi(async (base, store) => {
    await store.put({ userId: 'alice', notificationId: 'a1', message: 'old', createdAt: '2026-01-01T00:00:00Z' });
    await store.put({ userId: 'alice', notificationId: 'a2', message: 'new', createdAt: '2026-01-02T00:00:00Z' });
    await store.put({ userId: 'bob', notificationId: 'b1', message: 'bobs', createdAt: '2026-01-03T00:00:00Z' });

    const alice = await (await get(base, '/notifications', 'tok-alice')).json();
    assert.deepStrictEqual(alice.items.map((n) => n.message), ['new', 'old']);
    const bob = await (await get(base, '/notifications', 'tok-bob')).json();
    assert.strictEqual(bob.count, 1);
  }));

test('notifications cannot be created through the API', () =>
  withApi(async (base) => {
    const res = await fetch(`${base}/notifications`, { method: 'POST', body: '{}' });
    assert.strictEqual(res.status, 404);
  }));

test('server requires AUTH_URL', () => {
  assert.throws(() => createServer({}), /AUTH_URL/);
});

// ---------------------------------------------------------------- event consumer
test('an order.created event becomes a stored notification and the message is deleted', async () => {
  const store = memoryStore();
  const queue = fakeQueue([orderEvent('o-1')]);
  const consumer = createConsumer({ queue, handle: createEventHandler({ store, log: quiet }), log: quiet });

  assert.deepStrictEqual(await consumer.pollOnce(), { received: 1, processed: 1 });
  assert.deepStrictEqual(queue.removed, ['h0']);
  const [n] = await store.list('alice');
  assert.strictEqual(n.notificationId, 'order-created#o-1');
  assert.match(n.message, /o-1.*2 items/);
});

test('processing is idempotent: a redelivered message does not create a duplicate', async () => {
  const store = memoryStore();
  const queue = fakeQueue([orderEvent('o-1'), orderEvent('o-1')]);
  const consumer = createConsumer({ queue, handle: createEventHandler({ store, log: quiet }), log: quiet });
  await consumer.pollOnce();
  assert.strictEqual((await store.list('alice')).length, 1);
  assert.strictEqual(queue.removed.length, 2);
});

test('a failing message is NOT deleted (so SQS retries it and finally moves it to the DLQ)', async () => {
  const store = memoryStore();
  const queue = fakeQueue([]);
  // 1st message is not JSON, 2nd has no userId (handler throws), 3rd is fine
  queue.receive = (() => {
    const msgs = [
      { id: 'bad-json', body: '{not json', handle: 'h-bad' },
      { id: 'bad-event', body: JSON.stringify({ type: 'order.created', orderId: 'o-2' }), handle: 'h-bad2' },
      { id: 'good', body: orderEvent('o-3'), handle: 'h-good' },
    ];
    return async () => msgs.splice(0, 10);
  })();
  const consumer = createConsumer({ queue, handle: createEventHandler({ store, log: quiet }), log: quiet });

  assert.deepStrictEqual(await consumer.pollOnce(), { received: 3, processed: 1 });
  assert.deepStrictEqual(queue.removed, ['h-good']); // the two bad ones stay in the queue
  assert.strictEqual((await store.list('alice')).length, 1);
});

test('unknown event types are acknowledged and ignored', async () => {
  const store = memoryStore();
  const queue = fakeQueue([JSON.stringify({ type: 'something.else' })]);
  const consumer = createConsumer({ queue, handle: createEventHandler({ store, log: quiet }), log: quiet });
  assert.deepStrictEqual(await consumer.pollOnce(), { received: 1, processed: 1 });
});

test('start/stop loop keeps polling and stops cleanly', async () => {
  const store = memoryStore();
  let polls = 0;
  const queue = {
    receive: async (signal) => {
      polls++;
      if (polls === 1) return [{ id: 'm', body: orderEvent('o-9'), handle: 'h' }];
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, 20);
        signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); });
      });
      return [];
    },
    remove: async () => {},
  };
  const consumer = createConsumer({ queue, handle: createEventHandler({ store, log: quiet }), log: quiet, errorDelayMs: 5 });
  consumer.start();
  await new Promise((r) => setTimeout(r, 120));
  consumer.stop();
  const seen = polls;
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(seen >= 2, 'polled more than once');
  assert.strictEqual(polls, seen, 'no polling after stop()');
  assert.strictEqual((await store.list('alice')).length, 1);
});
