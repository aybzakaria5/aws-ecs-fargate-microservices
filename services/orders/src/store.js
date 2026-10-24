'use strict';
/**
 * Order storage.
 *  - DynamoDB when DYNAMODB_TABLE is set (table keys: userId = HASH, orderId = RANGE).
 *    In AWS the call goes through the DynamoDB gateway VPC endpoint using the task role.
 *    DYNAMODB_ENDPOINT can point to DynamoDB Local for local development.
 *  - In-memory Map otherwise (local runs and unit tests).
 */

function memoryStore() {
  const rows = new Map(); // `${userId}#${orderId}` -> order
  return {
    kind: 'memory',
    async put(order) {
      rows.set(`${order.userId}#${order.orderId}`, order);
    },
    async get(userId, orderId) {
      return rows.get(`${userId}#${orderId}`) || null;
    },
    async list(userId) {
      return [...rows.values()]
        .filter((o) => o.userId === userId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
  };
}

function dynamoStore({ table, region, endpoint }) {
  // Loaded lazily so the memory mode (and the unit tests) never need the AWS SDK at runtime.
  const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
  const { DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region, ...(endpoint ? { endpoint } : {}) }));

  return {
    kind: 'dynamodb',
    async put(order) {
      await client.send(new PutCommand({ TableName: table, Item: order }));
    },
    async get(userId, orderId) {
      const out = await client.send(new GetCommand({ TableName: table, Key: { userId, orderId } }));
      return out.Item || null;
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
  if (env.DYNAMODB_TABLE) {
    return dynamoStore({
      table: env.DYNAMODB_TABLE,
      region: env.AWS_REGION || env.AWS_DEFAULT_REGION || 'us-east-1',
      endpoint: env.DYNAMODB_ENDPOINT,
    });
  }
  return memoryStore();
}

module.exports = { createStore, memoryStore };
