'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createServer, signToken } = require('../src/server');

const SECRET = 'test-secret';

async function withServer(fn, opts = {}) {
  const server = createServer({ secret: SECRET, ...opts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const login = (base, body) =>
  fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('health endpoint', () =>
  withServer(async (base) => {
    const res = await fetch(`${base}/health`);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { status: 'ok', service: 'auth' });
  }));

test('login then verify round trip', () =>
  withServer(async (base) => {
    const res = await login(base, { username: 'alice', password: 'alice-demo-pw' });
    assert.strictEqual(res.status, 200);
    const { token } = await res.json();
    const ver = await fetch(`${base}/auth/verify`, { headers: { authorization: `Bearer ${token}` } });
    assert.strictEqual(ver.status, 200);
    assert.strictEqual((await ver.json()).user, 'alice');
  }));

test('wrong password and unknown user are rejected', () =>
  withServer(async (base) => {
    assert.strictEqual((await login(base, { username: 'alice', password: 'nope' })).status, 401);
    assert.strictEqual((await login(base, { username: 'mallory', password: 'x' })).status, 401);
    assert.strictEqual((await login(base, { username: '__proto__', password: 'x' })).status, 401);
  }));

test('verify rejects missing, tampered, wrong-key and expired tokens', () =>
  withServer(async (base) => {
    const get = (h) => fetch(`${base}/auth/verify`, { headers: h });
    assert.strictEqual((await get({})).status, 401);
    assert.strictEqual((await get({ authorization: 'Bearer abc.def.ghi' })).status, 401);

    const good = signToken({ sub: 'alice' }, SECRET, 60);
    const [h, , s] = good.split('.');
    const forgedBody = Buffer.from(JSON.stringify({ sub: 'admin', exp: 9999999999 })).toString('base64url');
    assert.strictEqual((await get({ authorization: `Bearer ${h}.${forgedBody}.${s}` })).status, 401);

    assert.strictEqual((await get({ authorization: `Bearer ${signToken({ sub: 'alice' }, 'other-key', 60)}` })).status, 401);
    assert.strictEqual((await get({ authorization: `Bearer ${signToken({ sub: 'alice' }, SECRET, -10)}` })).status, 401);
  }));

test('bad JSON gives 400 and unknown route 404', () =>
  withServer(async (base) => {
    const bad = await fetch(`${base}/auth/login`, { method: 'POST', body: '{not json' });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual((await fetch(`${base}/nope`)).status, 404);
  }));

test('server refuses to start without a secret', () => {
  assert.throws(() => createServer({}), /JWT_SECRET/);
});
