'use strict';

const crypto = require('crypto');

const ALPHANUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function randomId(len = 16) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHANUM[bytes[i] % ALPHANUM.length];
  return out;
}

function generateToken() {
  // redex_ + 43 chars of [A-Za-z0-9] ~= 256 bits of entropy
  return 'redex_' + randomId(43);
}

function sha256hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function constantTimeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) {
    // still do a comparison to keep timing flat-ish
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

function nowMs() {
  return Date.now();
}

function asBuffer(v) {
  if (v === undefined || v === null) return Buffer.alloc(0);
  if (Buffer.isBuffer(v)) return v;
  if (ArrayBuffer.isView(v)) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  if (Array.isArray(v)) return Buffer.from(String(v));
  return Buffer.from(String(v), 'utf8');
}

function byteLength(v) {
  return asBuffer(v).length;
}

function formatBytes(n) {
  if (!Number.isFinite(n)) return String(n);
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let x = n;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i++;
  }
  return `${x % 1 === 0 ? x : x.toFixed(1)} ${units[i]}`;
}

// ── HTTP helpers ─────────────────────────────────────────────────

const STATUS_TEXT = {
  200: 'OK', 201: 'Created', 204: 'No Content', 301: 'Moved Permanently',
  302: 'Found', 304: 'Not Modified', 400: 'Bad Request', 401: 'Unauthorized',
  403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed',
  409: 'Conflict', 413: 'Payload Too Large', 422: 'Unprocessable Entity',
  429: 'Too Many Requests', 500: 'Internal Server Error',
};

function sendJson(res, status, obj, extraHeaders = {}) {
  if (res.writableEnded) return;
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

/**
 * Read a request body up to maxBytes. When the body exceeds the limit we keep
 * draining (discarding) it so the socket stays clean for the 413 response —
 * a paused mid-stream request would otherwise wedge the connection.
 */
function readBody(req, maxBytes, hardCapBytes = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let overflow = false;
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      total += c.length;
      if (total > maxBytes) overflow = true;
      if (total > hardCapBytes) {
        done = true;
        req.destroy();
        resolve({ overflow: true, buffer: Buffer.alloc(0) });
        return;
      }
      if (!overflow) chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve({ overflow, buffer: Buffer.concat(chunks) });
    });
    req.on('error', (e) => {
      if (done) return;
      done = true;
      reject(e);
    });
  });
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function setSessionCookie(res, cookieName, value, maxAgeSeconds) {
  const parts = [
    `${cookieName}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  const prev = res.getHeader('Set-Cookie');
  const arr = prev ? (Array.isArray(prev) ? prev.concat(parts.join('; ')) : [prev, parts.join('; ')]) : [parts.join('; ')];
  res.setHeader('Set-Cookie', arr);
}

function clearSessionCookie(res, cookieName) {
  const parts = [`${cookieName}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  const prev = res.getHeader('Set-Cookie');
  const arr = prev ? (Array.isArray(prev) ? prev.concat(parts.join('; ')) : [prev, parts.join('; ')]) : [parts.join('; ')];
  res.setHeader('Set-Cookie', arr);
}

function rateLimitHeaders(rl) {
  const h = {};
  if (rl) {
    h['X-RateLimit-Limit'] = String(rl.capacity + rl.maxBurst);
    h['X-RateLimit-Remaining'] = String(Math.max(0, Math.floor(rl.tokens)));
    h['X-RateLimit-Reset'] = String(Math.ceil(rl.resetMs));
  }
  return h;
}

module.exports = {
  randomId,
  generateToken,
  sha256hex,
  constantTimeEqual,
  nowMs,
  asBuffer,
  byteLength,
  formatBytes,
  sendJson,
  readBody,
  parseCookies,
  setSessionCookie,
  clearSessionCookie,
  rateLimitHeaders,
};
