'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const { createQueue } = require('../src/queue');

// The AWS SDK reads credentials from the process environment (not from the object passed to the adapter).
// Fake ones keep these tests independent of the machine they run on (CI runners have no AWS credentials).
process.env.AWS_ACCESS_KEY_ID = 'test';
process.env.AWS_SECRET_ACCESS_KEY = 'test';

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

test('no queue configured -> consumer is disabled', () => {
  assert.strictEqual(createQueue({}), null);
});

test('SQS adapter receives messages with long polling and deletes them by receipt handle', async () => {
  const calls = [];
  const stub = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const op = (req.headers['x-amz-target'] || '').split('.')[1];
      const body = JSON.parse(raw || '{}');
      calls.push({ op, body });
      res.writeHead(200, { 'content-type': 'application/x-amz-json-1.0' });
      if (op === 'ReceiveMessage') {
        const text = JSON.stringify({ type: 'order.created', orderId: 'o-1' });
        return res.end(JSON.stringify({ Messages: [{ MessageId: 'id-1', ReceiptHandle: 'rh-1', Body: text, MD5OfBody: md5(text) }] }));
      }
      res.end('{}');
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const port = stub.address().port;
  try {
    const queue = createQueue({
      ORDER_EVENTS_QUEUE_URL: `http://127.0.0.1:${port}/000000000000/order-events`,
      SQS_ENDPOINT: `http://127.0.0.1:${port}`,
      SQS_WAIT_SECONDS: '20',
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'test',
      AWS_SECRET_ACCESS_KEY: 'test',
    });
    const [m] = await queue.receive(new AbortController().signal);
    assert.strictEqual(m.id, 'id-1');
    assert.strictEqual(JSON.parse(m.body).orderId, 'o-1');
    await queue.remove(m.handle);

    assert.strictEqual(calls[0].body.WaitTimeSeconds, 20);
    assert.strictEqual(calls[0].body.MaxNumberOfMessages, 10);
    assert.strictEqual(calls[1].op, 'DeleteMessage');
    assert.strictEqual(calls[1].body.ReceiptHandle, 'rh-1');
  } finally {
    await new Promise((r) => stub.close(r));
  }
});
