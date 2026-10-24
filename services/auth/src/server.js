'use strict';
/**
 * Auth service
 *   POST /auth/login   { username, password } -> { token, expiresIn }
 *   GET  /auth/verify  Authorization: Bearer <token> -> { user }
 *   GET  /health       liveness / ALB health check
 *
 * Zero runtime dependencies on purpose: JWT (HS256) is implemented with
 * node:crypto. The signing key comes from the JWT_SECRET environment variable,
 * which ECS injects from AWS Secrets Manager at task start.
 */
const http = require('node:http');
const crypto = require('node:crypto');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const sign = (data, secret) => crypto.createHmac('sha256', secret).update(data).digest('base64url');

function signToken(payload, secret, ttlSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ ...payload, iat: now, exp: now + ttlSeconds }));
  return `${header}.${body}.${sign(`${header}.${body}`, secret)}`;
}

function verifyToken(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const expected = Buffer.from(sign(`${parts[0]}.${parts[1]}`, secret));
  const given = Buffer.from(parts[2]);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (typeof claims.exp !== 'number' || claims.exp < Math.floor(Date.now() / 1000)) return null;
    return claims;
  } catch {
    return null;
  }
}

const safeEqual = (a, b) => {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};

function log(level, msg, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, service: 'auth', msg, ...extra }));
}

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function readJson(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {});
      } catch {
        reject(Object.assign(new Error('invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

// Demo users only. A real system would use Amazon Cognito or a user table with hashed passwords.
const DEFAULT_USERS = { alice: 'alice-demo-pw', bob: 'bob-demo-pw' };

function createServer({ secret, users = DEFAULT_USERS, ttlSeconds = 3600 } = {}) {
  if (!secret) throw new Error('JWT_SECRET is required');

  return http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        return send(res, 200, { status: 'ok', service: 'auth' });
      }

      if (req.method === 'POST' && url.pathname === '/auth/login') {
        const { username, password } = await readJson(req);
        const known = Object.prototype.hasOwnProperty.call(users, username);
        if (!known || !safeEqual(users[username], password ?? '')) {
          return send(res, 401, { error: 'invalid credentials' });
        }
        const token = signToken({ sub: username }, secret, ttlSeconds);
        return send(res, 200, { token, expiresIn: ttlSeconds });
      }

      if (req.method === 'GET' && url.pathname === '/auth/verify') {
        const header = req.headers.authorization || '';
        const claims = header.startsWith('Bearer ') ? verifyToken(header.slice(7), secret) : null;
        if (!claims) return send(res, 401, { error: 'invalid or expired token' });
        return send(res, 200, { user: claims.sub, exp: claims.exp });
      }

      return send(res, 404, { error: 'not found' });
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) log('error', 'unhandled error', { error: err.message });
      return send(res, status, { error: status === 500 ? 'internal error' : err.message });
    } finally {
      if (url.pathname !== '/health') {
        log('info', 'request', { method: req.method, path: url.pathname, status: res.statusCode, ms: Date.now() - started });
      }
    }
  });
}

module.exports = { createServer, signToken, verifyToken };

if (require.main === module) {
  let secret = process.env.JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      log('error', 'JWT_SECRET is not set');
      process.exit(1);
    }
    secret = 'dev-only-secret';
    log('warn', 'JWT_SECRET not set, using an insecure development secret');
  }
  const port = Number(process.env.PORT || 3000);
  const server = createServer({ secret });
  server.listen(port, '0.0.0.0', () => log('info', 'listening', { port }));
  // Fargate sends SIGTERM on deployments / scale-in: stop accepting, finish in-flight requests.
  process.on('SIGTERM', () => {
    log('info', 'SIGTERM received, shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 8000).unref();
  });
}
