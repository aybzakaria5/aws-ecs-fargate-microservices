'use strict';
/**
 * Pulls messages from the queue and hands each one to `handle`.
 *
 * Delivery semantics (SQS standard queue = at-least-once):
 *  - a message is deleted only AFTER it was handled successfully;
 *  - if handling throws, the message is left alone: it becomes visible again after the visibility timeout
 *    and is retried; after maxReceiveCount failed receives SQS moves it to the dead-letter queue (DLQ),
 *    where an alarm tells the operator;
 *  - because a message can be delivered more than once, handlers must be idempotent.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createConsumer({ queue, handle, log, errorDelayMs = 5000 }) {
  let stopped = false;
  let controller = new AbortController();

  async function pollOnce(signal) {
    const messages = await queue.receive(signal);
    let processed = 0;
    for (const m of messages) {
      try {
        await handle(JSON.parse(m.body));
        await queue.remove(m.handle);
        processed++;
      } catch (err) {
        log('error', 'message processing failed; it will be retried, then moved to the DLQ', {
          messageId: m.id,
          error: err.message,
        });
      }
    }
    return { received: messages.length, processed };
  }

  async function run() {
    while (!stopped) {
      try {
        await pollOnce(controller.signal);
      } catch (err) {
        if (stopped) break; // the long poll was aborted by stop()
        log('error', 'queue receive failed, backing off', { error: err.message });
        await sleep(errorDelayMs);
      }
    }
  }

  return {
    pollOnce,
    start() {
      stopped = false;
      controller = new AbortController();
      run();
    },
    stop() {
      stopped = true;
      controller.abort();
    },
  };
}

module.exports = { createConsumer };
