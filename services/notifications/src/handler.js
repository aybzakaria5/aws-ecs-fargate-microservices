'use strict';
/**
 * Turns domain events into stored notifications ("sending" is simulated: the notification is written to
 * DynamoDB and logged, which ends up in CloudWatch Logs). A real system would also call SNS / SES here.
 */

function createEventHandler({ store, log }) {
  return async function handleEvent(event) {
    if (!event || typeof event !== 'object') throw new Error('event must be a JSON object');

    if (event.type === 'order.created') {
      if (!event.orderId || !event.userId) throw new Error('order.created needs orderId and userId');
      const count = Number(event.itemCount) || 0;
      const notification = {
        userId: event.userId,
        // Deterministic id: a redelivered message overwrites the same item instead of creating a duplicate.
        notificationId: `order-created#${event.orderId}`,
        type: event.type,
        message: `Your order ${event.orderId} was received (${count} item${count === 1 ? '' : 's'}).`,
        status: 'sent',
        createdAt: new Date().toISOString(),
      };
      await store.put(notification);
      log('info', 'notification sent', { userId: notification.userId, notificationId: notification.notificationId });
      return;
    }

    // Unknown event types are acknowledged and ignored so they never block the queue.
    log('warn', 'ignoring unknown event type', { type: event.type });
  };
}

module.exports = { createEventHandler };
