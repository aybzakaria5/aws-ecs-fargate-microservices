'use strict';
/**
 * Notification storage.
 *  - DynamoDB when NOTIFICATIONS_TABLE is set (keys: userId = HASH, notificationId = RANGE).
 *    All tasks share the table, so GET /notifications returns the same data whichever task answers.
 *  - In-memory Map otherwise (local runs and unit tests).
 * put() is an upsert on (userId, notificationId), which is what makes event handling idempotent.
 */

function memoryStore() {
  const rows = new Map();
  return {
    kind: 'memory',
    async put(n) {
      rows.set(`${n.userId}#${n.notificationId}`, n);
    },
    async list(userId) {
      return [...rows.values()]
        .filter((n) => n.userId === userId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
  };
}

function dynamoStore({ table, region, endpoint }) {
  const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
  const { DynamoDBDocumentClient, PutCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region, ...(endpoint ? { endpoint } : {}) }));
  return {
    kind: 'dynamodb',
    async put(n) {
      await client.send(new PutCommand({ TableName: table, Item: n }));
    },
    async list(userId) {
      const out = await client.send(
        new QueryCommand({
          TableName: table,
          KeyConditionExpression: 'userId = :u',
          ExpressionAttributeValues: { ':u': userId },
          Limit: 100,
        }),
      );
      return (out.Items || []).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
  };
}

function createStore(env = process.env) {
  if (env.NOTIFICATIONS_TABLE) {
    return dynamoStore({
      table: env.NOTIFICATIONS_TABLE,
      region: env.AWS_REGION || env.AWS_DEFAULT_REGION || 'us-east-1',
      endpoint: env.DYNAMODB_ENDPOINT,
    });
  }
  return memoryStore();
}

module.exports = { createStore, memoryStore };
