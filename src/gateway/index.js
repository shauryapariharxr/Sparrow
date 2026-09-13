'use strict';

/**
 * The REST API gateway + control-plane HTTP surface.
 *
 * Data plane (Bearer token):
 *   POST /{CMD}/{arg}/{arg}...   single command, path style
 *   POST /                       JSON array command or pipeline
 *   POST /pipeline               { "commands": [[...], ...] }
 *   GET  /subscribe/{channel}    Server-Sent Events subscription
 *   GET  /usage                  usage + storage stats for this database
 *
 * Control plane (session cookie):
 *   POST /auth/signup | /auth/login | POST /auth/logout | GET /auth/me
 *   GET|POST /databases          list | create
 *   DELETE /databases/{id}       delete (+ engine files)
 *   GET|POST /databases/{id}/tokens  list | create
 *   DELETE /tokens/{tokenId}     revoke
 *   GET  /dashboard              built-in UI
 */

const {
  sendJson, readBody, parseCookies, setSessionCookie, clearSessionCookie,
  rateLimitHeaders, formatBytes,
} = require('../util');
const { replyToJson } = require('./serialization');
const { binaryToJsonString } = require('./serialization');

const READ_COMMANDS = new Set([
  'GET', 'MGET', 'STRLEN', 'GETRANGE', 'EXISTS', 'TYPE', 'KEYS', 'SCAN', 'RANDOMKEY',
  'TTL', 'PTTL', 'DBSIZE', 'LLEN', 'LINDEX', 'LRANGE', 'SCARD', 'SMEMBERS', 'SISMEMBER',
  'SMISMEMBER', 'SRANDMEMBER', 'SUNION', 'SINTER', 'SDIFF', 'ZSCORE', 'ZMSCORE', 'ZCARD',
  'ZCOUNT', 'ZRANGE', 'ZRANGEBYSCORE', 'ZREVRANGE', 'ZREVRANGEBYSCORE', 'ZRANGEBYLEX',
  'ZREVRANGEBYLEX', 'ZRANK', 'ZREVRANK', 'HGET', 'HMGET', 'HGETALL', 'HEXISTS', 'HKEYS',
  'HVALS', 'HLEN', 'HSTRLEN', 'PING', 'ECHO', 'TIME',
]);

const MAX_PIPELINE_COMMANDS = 1000;
const SSE_HEARTBEAT_MS = 15_000;

class UsageBuffer {
  constructor(control, flushMs = 5000) {
    this.control = control;
    this.map = new Map();
    this.timer = setInterval(() => this.flush(), flushMs);
    this.timer.unref();
  }
  bump(dbId) { this.map.set(dbId, (this.map.get(dbId) || 0) + 1); }
  flush() {
    if (this.map.size === 0) return;
    for (const [dbId, n] of this.map) this.control.bumpUsage(dbId, n);
    this.map.clear();
  }
  stop() { clearInterval(this.timer); this.flush(); }
}

class Gateway {
  constructor({ control, tenants, rateLimiter, config }) {
    this.control = control;
    this.tenants = tenants;
    this.rateLimiter = rateLimiter;
    this.config = config;
    this.usage = new UsageBuffer(control);
    this.startedAt = Date.now();
    const { WebApi } = require('../web/server');
    this.web = new WebApi({ control, tenants, config });
  }

  stop() { this.usage.stop(); }

  // ── main entry ──────────────────────────────────────────────────
  async handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    try {
      if (req.method === 'OPTIONS') return this.handleCors(req, res);

      // Health / info
      if (pathname === '/healthz' || pathname === '/healthz/') {
        return sendJson(res, 200, { ok: true, uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000), loadedTenants: this.tenants.stats.loadedTenants });
      }
      // Web: landing/auth/dashboard pages, assets, dashboard introspection API
      if (this.web.tryHandle(req, res, pathname)) return;

      // Control plane
      if (pathname.startsWith('/auth/') || pathname === '/databases' || pathname.startsWith('/databases/') || pathname.startsWith('/tokens/')) {
        return this.handleControl(req, res, pathname);
      }

      // Data plane below this point
      return await this.handleData(req, res, pathname, url);
    } catch (err) {
      console.error(`[sparrow:gateway] ${req.method} ${pathname} failed:`, err);
      if (!res.writableEnded) sendJson(res, 500, { error: 'Internal error' });
    }
  }

  handleCors(req, res) {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '86400',
    });
    res.end();
  }

  // ── data plane ──────────────────────────────────────────────────
  async handleData(req, res, pathname, url) {
    const auth = this.authRequest(req, res);
    if (!auth) return; // response already sent

    // Usage endpoint
    if (pathname === '/usage' || pathname === '/usage/') {
      this.usage.flush(); // make buffered counts visible immediately
      const info = this.engineInfo(auth.db);
      const usage = this.control.getUsageSummary(auth.db.id);
      return sendJson(res, 200, { database: { id: auth.db.id, name: auth.db.name }, usage, storage: info }, { 'X-Sparrow-Database': auth.db.id });
    }

    // Pub/sub over SSE
    if (pathname.startsWith('/subscribe/') && req.method === 'GET') {
      return this.handleSubscribe(req, res, auth, pathname.slice('/subscribe/'.length));
    }

    // Build argv
    let argv = null;
    let pipeline = null;
    if (pathname === '/' || pathname === '/pipeline') {
      const body = await readBody(req, this.config.maxPayloadBytes);
      if (body.overflow) {
        return sendJson(res, 413, { error: `Request body too large (limit ${formatBytes(this.config.maxPayloadBytes)})` });
      }
      const raw = body.buffer;
      if (raw.length === 0) return sendJson(res, 400, { error: 'Empty request body — send a JSON array like ["GET","key"]' });
      let parsed;
      try {
        parsed = JSON.parse(raw.toString('utf8'));
      } catch {
        return sendJson(res, 400, { error: 'Invalid JSON body' });
      }
      if (Array.isArray(parsed) && parsed.every((x) => Array.isArray(x))) {
        pipeline = parsed;
      } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.commands)) {
        pipeline = parsed.commands;
      } else if (Array.isArray(parsed) && parsed.length > 0) {
        argv = parsed;
      } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.command)) {
        argv = parsed.command;
      } else {
        return sendJson(res, 400, { error: 'Body must be a command array like ["GET","key"] or {"commands": [[...], ...]}' });
      }
    } else {
      // Path style: /SET/key/value
      const parts = pathname.slice(1).split('/').filter((p) => p.length > 0).map(decodeSafe);
      if (parts.length === 0) return sendJson(res, 404, { error: 'Not found' });
      argv = parts;
    }

    // Rate limiting (pipelines cost more than single commands)
    const cost = pipeline ? 1 + Math.floor(pipeline.length / 10) : 1;
    const rl = this.rateLimiter.take(auth.tokenHash, cost);
    if (!rl.ok) {
      return sendJson(res, 429, { error: 'Rate limit exceeded' }, {
        'Retry-After': String(Math.max(1, Math.ceil(rl.resetMs / 1000))),
        ...rateLimitHeaders(rl),
      });
    }
    const rlHeaders = rateLimitHeaders(rl);

    if (pipeline) {
      if (pipeline.length > MAX_PIPELINE_COMMANDS) {
        return sendJson(res, 400, { error: `Pipeline too large (max ${MAX_PIPELINE_COMMANDS} commands)` });
      }
      const normalized = [];
      for (const cmd of pipeline) {
        const a = normalizeArgv(cmd);
        if (!a) return sendJson(res, 400, { error: 'Each pipeline entry must be a non-empty array of strings' });
        normalized.push(a);
      }
      if (normalized.some((a) => !READ_COMMANDS.has(a.name)) && auth.readonly) {
        return sendJson(res, 403, { error: 'This token is read-only' });
      }
      const tdb = this.tenants.get(auth.db.id, auth.db);
      const results = normalized.map((a) => {
        this.usage.bump(auth.db.id);
        return replyToJson(tdb.execute(a.argv));
      });
      return sendJson(res, 200, results, { 'X-Sparrow-Database': auth.db.id, ...rlHeaders });
    }

    // Single command
    const a = normalizeArgv(argv);
    if (!a) return sendJson(res, 400, { error: 'Command must be a non-empty array of strings' });
    if (!READ_COMMANDS.has(a.name)) {
      if (req.method !== 'POST') {
        return sendJson(res, 405, { error: `Use POST for ${a.name}` }, { Allow: 'POST' });
      }
      if (auth.readonly) return sendJson(res, 403, { error: 'This token is read-only' });
    }
    this.usage.bump(auth.db.id);
    const tdb = this.tenants.get(auth.db.id, auth.db);
    const reply = tdb.execute(a.argv);
    const body = replyToJson(reply);
    const status = body.error ? 400 : 200;
    return sendJson(res, status, body, { 'X-Sparrow-Database': auth.db.id, ...rlHeaders });
  }

  handleSubscribe(req, res, auth, channel) {
    if (!channel) return sendJson(res, 400, { error: 'Channel required: GET /subscribe/{channel}' });
    const rl = this.rateLimiter.take(auth.tokenHash);
    if (!rl.ok) {
      return sendJson(res, 429, { error: 'Rate limit exceeded' }, { 'Retry-After': String(Math.max(1, Math.ceil(rl.resetMs / 1000))) });
    }
    const tdb = this.tenants.get(auth.db.id, auth.db);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: ready\ndata: ${JSON.stringify({ channel })}\n\n`);
    const unsub = tdb.pubsub.subscribe(channel, (ch, message) => {
      res.write(`event: message\ndata: ${JSON.stringify({ channel: ch, message: binaryToJsonString(message) })}\n\n`);
    });
    const hb = setInterval(() => res.write(': keepalive\n\n'), SSE_HEARTBEAT_MS);
    req.on('close', () => {
      clearInterval(hb);
      unsub();
    });
  }

  engineInfo(db) {
    const tdb = this.tenants.get(db.id, db);
    const s = tdb.engine.keyspace.stats;
    return {
      keys: s.keyCount,
      memoryBytes: s.memoryBytes,
      limits: {
        maxKeys: db.maxKeys,
        maxMemoryBytes: db.maxMemoryBytes,
        maxValueBytes: db.maxValueBytes,
      },
    };
  }

  /** Resolve Bearer token; sends the error response and returns null on failure. */
  authRequest(req, res) {
    const header = req.headers.authorization;
    if (!header || !/^Bearer\s+/i.test(header)) {
      sendJson(res, 401, { error: 'Missing Authorization header — send "Authorization: Bearer <token>"' }, { 'WWW-Authenticate': 'Bearer' });
      return null;
    }
    const raw = header.replace(/^Bearer\s+/i, '').trim();
    const resolved = this.control.authenticateApiToken(raw);
    if (!resolved) {
      sendJson(res, 401, { error: 'Invalid or revoked API token' }, { 'WWW-Authenticate': 'Bearer' });
      return null;
    }
    const hash = require('../util').sha256hex(raw);
    return { db: resolved.db, readonly: resolved.readonly, tokenHash: hash };
  }

  // ── control plane ───────────────────────────────────────────────
  async handleControl(req, res, pathname) {
    const method = req.method;

    if (pathname === '/auth/signup' && method === 'POST') return this.authSignup(req, res);
    if (pathname === '/auth/login' && method === 'POST') return this.authLogin(req, res);
    if (pathname === '/auth/logout' && method === 'POST') return this.authLogout(req, res);
    if (pathname === '/auth/me' && method === 'GET') return this.authMe(req, res);

    const user = this.sessionUser(req);
    if (!user) return sendJson(res, 401, { error: 'Not signed in' });

    if (pathname === '/databases' && method === 'GET') {
      const dbs = this.control.listDatabases(user.id).map((db) => ({ ...publicDb(db) }));
      return sendJson(res, 200, { databases: dbs });
    }
    if (pathname === '/databases' && method === 'POST') {
      const body = await readJson(req, res, this.config);
      if (body === null) return;
      const r = this.control.createDatabase(user.id, body.name);
      if (r.err) return sendJson(res, r.err.status, { error: r.err.message });
      this.tenants.create(r.db.id, r.db);
      return sendJson(res, 201, { database: publicDb(r.db) });
    }
    const dbMatch = pathname.match(/^\/databases\/([^/]+)$/);
    if (dbMatch && method === 'DELETE') {
      const db = this.control.getDatabase(dbMatch[1]);
      if (!db || db.userId !== user.id) return sendJson(res, 404, { error: 'Database not found' });
      this.tenants.destroy(db.id);
      this.control.deleteDatabase(db.id);
      return sendJson(res, 200, { ok: true });
    }
    const tokMatch = pathname.match(/^\/databases\/([^/]+)\/tokens$/);
    if (tokMatch && method === 'GET') {
      const db = this.control.getDatabase(tokMatch[1]);
      if (!db || db.userId !== user.id) return sendJson(res, 404, { error: 'Database not found' });
      return sendJson(res, 200, { tokens: this.control.listTokens(db.id) });
    }
    if (tokMatch && method === 'POST') {
      const db = this.control.getDatabase(tokMatch[1]);
      if (!db || db.userId !== user.id) return sendJson(res, 404, { error: 'Database not found' });
      const body = (await readJson(req, res, this.config)) || {};
      const { token, plaintext } = this.control.createToken(db.id, body);
      return sendJson(res, 201, { token, token_plaintext: plaintext });
    }
    const revokeMatch = pathname.match(/^\/tokens\/([^/]+)$/);
    if (revokeMatch && method === 'DELETE') {
      // Find the token among the user's databases.
      for (const db of this.control.listDatabases(user.id)) {
        if (this.control.revokeToken(db.id, revokeMatch[1])) {
          return sendJson(res, 200, { ok: true });
        }
      }
      return sendJson(res, 404, { error: 'Token not found' });
    }

    return sendJson(res, 404, { error: 'Not found' });
  }

  sessionUser(req) {
    const cookies = parseCookies(req);
    const session = this.control.validateSession(cookies[this.config.cookieName]);
    if (!session) return null;
    return this.control.store.getUserById(session.userId);
  }

  async authSignup(req, res) {
    const body = await readJson(req, res, this.config);
    if (body === null) return;
    const r = this.control.signup(body.email, body.password);
    if (r.err) return sendJson(res, r.err.status, { error: r.err.message });
    const session = this.control.createSession(r.user.id);
    setSessionCookie(res, this.config.cookieName, session.token, this.config.sessionTtlHours * 3600);
    return sendJson(res, 201, { user: { id: r.user.id, email: r.user.email } });
  }

  async authLogin(req, res) {
    const body = await readJson(req, res, this.config);
    if (body === null) return;
    const r = this.control.login(body.email, body.password);
    if (r.err) return sendJson(res, r.err.status, { error: r.err.message });
    const session = this.control.createSession(r.user.id);
    setSessionCookie(res, this.config.cookieName, session.token, this.config.sessionTtlHours * 3600);
    return sendJson(res, 200, { user: { id: r.user.id, email: r.user.email } });
  }

  authLogout(req, res) {
    const cookies = parseCookies(req);
    const token = cookies[this.config.cookieName];
    if (token) this.control.logout(token);
    clearSessionCookie(res, this.config.cookieName);
    return sendJson(res, 200, { ok: true });
  }

  authMe(req, res) {
    const user = this.sessionUser(req);
    if (!user) return sendJson(res, 401, { error: 'Not signed in' });
    return sendJson(res, 200, { user: { id: user.id, email: user.email } });
  }
}

function publicDb(db) {
  return {
    id: db.id, name: db.name, createdAt: db.createdAt,
    maxKeys: db.maxKeys, maxMemoryBytes: db.maxMemoryBytes, maxValueBytes: db.maxValueBytes,
  };
}

function decodeSafe(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** argv entries must be non-empty strings; numbers become strings.
 *  Returns { name, argv } — name is the uppercased command for ACL checks. */
function normalizeArgv(cmd) {
  if (!Array.isArray(cmd) || cmd.length === 0) return null;
  const out = [];
  for (const part of cmd) {
    if (typeof part === 'string') {
      if (part.length === 0) return null;
      out.push(Buffer.from(part, 'utf8'));
    } else if (typeof part === 'number' && Number.isFinite(part)) {
      out.push(Buffer.from(String(part), 'utf8'));
    } else {
      return null;
    }
  }
  const name = out[0].toString('utf8').toUpperCase();
  out[0] = Buffer.from(name, 'utf8');
  return { name, argv: out };
}

async function readJson(req, res, config) {
  const body = await readBody(req, config.maxPayloadBytes);
  if (body.overflow) {
    sendJson(res, 413, { error: `Request body too large (limit ${formatBytes(config.maxPayloadBytes)})` });
    return null;
  }
  const raw = body.buffer;
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return null;
  }
}

module.exports = { Gateway, READ_COMMANDS };
