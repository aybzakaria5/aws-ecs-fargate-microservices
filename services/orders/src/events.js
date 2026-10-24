'use strict';
/**
 * Publishes domain events to Amazon SQS so that other services (Notifications) can react
 * asynchronously. Orders does not know who consumes the events, and does not wait for them.
 *
 *  - ORDER_EVENTS_QUEUE_URL set  -> SQS (in AWS the call goes through the SQS interface VPC endpoint).
 *    SQS_ENDPOINT can point to a local SQS-compatible server (ElasticMQ) for development.
 *  - not set                     -> events are dropped (local runs and unit tests).
 */

function noopPublisher() {
  return { kind: 'none', async publish() {} };
}

function sqsPublisher({ queueUrl, region, endpoint }) {
  // Loaded lazily so the unit tests and the no-queue mode never need the AWS SDK at runtime.
  const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
  const client = new SQSClient({ region, ...(endpoint ? { endpoint } : {}) });
  return {
    kind: 'sqs',
    async publish(event) {
      await client.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(event) }));
    },
  };
}

function createPublisher(env = process.env) {
  if (!env.ORDER_EVENTS_QUEUE_URL) return noopPublisher();
  return sqsPublisher({
    queueUrl: env.ORDER_EVENTS_QUEUE_URL,
    region: env.AWS_REGION || env.AWS_DEFAULT_REGION || 'us-east-1',
    endpoint: env.SQS_ENDPOINT,
  });
}

module.exports = { createPublisher, noopPublisher };
