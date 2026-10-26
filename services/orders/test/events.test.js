'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const { createPublisher } = require('../src/events');

// The AWS SDK reads credentials from the process environment (not from the object passed to the adapter).
// Fake ones keep these tests independent of the machine they run on (CI runners have no AWS credentials).
process.env.AWS_ACCESS_KEY_ID = 'test';
process.env.AWS_SECRET_ACCESS_KEY = 'test';

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

test('no queue configured -> events are dropped silently', async () => {
  const p = createPublisher({});
  assert.strictEqual(p.kind, 'none');
  await p.publish({ type: 'order.created' });
});

test('SQS publisher sends the event as a JSON message body to the configured queue', async () => {
  const received = [];
  const stub = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw);
      received.push({ target: req.headers['x-amz-target'], body });
      res.writeHead(200, { 'content-type': 'application/x-amz-json-1.0' });
      res.end(JSON.stringify({ MessageId: 'm-1', MD5OfMessageBody: md5(body.MessageBody) }));
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const port = stub.address().port;
  try {
    const publisher = createPublisher({
      ORDER_EVENTS_QUEUE_URL: `http://127.0.0.1:${port}/000000000000/order-events`,
      SQS_ENDPOINT: `http://127.0.0.1:${port}`,
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'test',
      AWS_SECRET_ACCESS_KEY: 'test',
    });
    assert.strictEqual(publisher.kind, 'sqs');
    await publisher.publish({ type: 'order.created', orderId: 'o-1' });

    assert.strictEqual(received.length, 1);
    assert.match(received[0].target, /SendMessage$/);
    assert.match(received[0].body.QueueUrl, /order-events$/);
    assert.deepStrictEqual(JSON.parse(received[0].body.MessageBody), { type: 'order.created', orderId: 'o-1' });
  } finally {
    await new Promise((r) => stub.close(r));
  }
});
