'use strict';
/**
 * Thin adapter over Amazon SQS so the consumer logic can be tested without the AWS SDK.
 * A queue object has: receive(signal) -> [{ id, body, handle }]  and  remove(handle).
 * In AWS the calls go through the SQS interface VPC endpoint; SQS_ENDPOINT points to ElasticMQ locally.
 */

function createQueue(env = process.env) {
  if (!env.ORDER_EVENTS_QUEUE_URL) return null;

  const { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } = require('@aws-sdk/client-sqs');
  const queueUrl = env.ORDER_EVENTS_QUEUE_URL;
  const client = new SQSClient({
    region: env.AWS_REGION || env.AWS_DEFAULT_REGION || 'us-east-1',
    ...(env.SQS_ENDPOINT ? { endpoint: env.SQS_ENDPOINT } : {}),
  });
  const waitSeconds = Number(env.SQS_WAIT_SECONDS ?? 20); // long polling: fewer empty receives, lower cost

  return {
    kind: 'sqs',
    async receive(abortSignal) {
      const out = await client.send(
        new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: waitSeconds }),
        { abortSignal },
      );
      return (out.Messages || []).map((m) => ({ id: m.MessageId, body: m.Body, handle: m.ReceiptHandle }));
    },
    async remove(handle) {
      await client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: handle }));
    },
  };
}

module.exports = { createQueue };
