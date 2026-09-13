'use strict';

/**
 * Web layer: marketing pages, auth pages, dashboard SPA and static assets.
 * Also owns the session-scoped introspection endpoints the dashboard uses:
 *
 *   GET /usage/:dbId      { usage: { today, history }, storage: { keys, memoryBytes } }
 *   GET /storage/:dbId    { keys, memoryBytes, limits }
 *   GET /databases/:dbId/data   up to 200 keys with type / preview / ttl
 *
 * All three authenticate with the session cookie AND verify the database
 * belongs to the session user — never a token, never client-supplied scope.
 */

const fs = require('fs');
const path = require('path');

const STATIC_DIR = path.join(__dirname);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const PAGES = {
  '/': 'landing.html',
  '/index.html': 'landing.html',
  '/login': 'auth.html',
  '/signup': 'auth.html',
  '/dashboard': 'dashboard.html',
  '/dashboard/': 'dashboard.html',
};

const STATIC_FILES = {
  '/favicon.svg': 'favicon.svg',
  '/logo.svg': 'sparrow.svg',
  '/logo-gradient.svg': 'sparrow-gradient.svg',
};

function contentType(p) {
  return MIME[path.extname(p)] || 'application/octet-stream';
}

function sendHtml(res, status, html) {
  if (res.writableEnded) return;
  const body = Buffer.from(html);
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

function sendAsset(res, file, cacheable) {
  let data;
  try {
    data = fs.readFileSync(path.join(STATIC_DIR, file));
  } catch {
    return false;
  }
  res.writeHead(200, {
    'Content-Type': contentType(file),
    'Content-Length': data.length,
    'Cache-Control': cacheable ? 'public, max-age=86400' : 'no-cache',
  });
  res.end(data);
  return true;
}

function handleWeb(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;

  const page = PAGES[pathname];
  if (page) {
    if (pathname === '/signup') {
      // Canonical auth page; /login?mode=signup works too.
      return sendAsset(res, page, false);
    }
    return sendAsset(res, page, false);
  }

  const asset = STATIC_FILES[pathname];
  if (asset) return sendAsset(res, asset, true);

  if (pathname === '/robots.txt') {
    const body = 'User-agent: *\nAllow: /\nDisallow: /dashboard\n';
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.length });
    res.end(body);
    return true;
  }

  return false;
}

/** Render the landing page with hardcoded values (no user context needed). */
function renderPublic(pathname, res) {
  return handleWeb({ method: 'GET' }, res, pathname);
}

class WebApi {
  constructor({ control, tenants, config }) {
    this.control = control;
    this.tenants = tenants;
    this.config = config;
  }

  sessionUser(req) {
    const { parseCookies } = require('../util');
    const cookies = parseCookies(req);
    const session = this.control.validateSession(cookies[this.config.cookieName]);
    if (!session) return null;
    return this.control.store.getUserById(session.userId);
  }

  /** Returns true when the request was handled as a web/page/asset route. */
  tryHandle(req, res, pathname) {
    // Static + pages first (no auth).
    if (handleWeb(req, res, pathname)) return true;

    // Session-scoped introspection endpoints for the dashboard.
    const m = pathname.match(/^\/(usage|storage|databases)\/([^/]+)(\/data)?$/);
    if (m && req.method === 'GET') {
      const kind = m[1];
      const dbId = m[2];
      const isData = kind === 'databases' && !!m[3];
      if (kind !== 'databases' || isData) return this.handleIntrospect(req, res, kind, dbId);
      return false; // /databases/:id without /data — not ours
    }
    return false;
  }

  handleIntrospect(req, res, kind, dbId) {
    const { sendJson } = require('../util');
    const user = this.sessionUser(req);
    if (!user) return sendJson(res, 401, { error: 'Not signed in' });
    const db = this.control.getDatabase(dbId);
    if (!db || db.userId !== user.id) return sendJson(res, 404, { error: 'Database not found' });

    const tdb = this.tenants.get(db.id, db);
    const stats = tdb.engine.keyspace.stats;

    if (kind === 'usage') {
      const usage = this.control.getUsageSummary(db.id);
      return sendJson(res, 200, {
        database: { id: db.id, name: db.name },
        usage,
        storage: { keys: stats.keyCount, memoryBytes: stats.memoryBytes },
      });
    }
    if (kind === 'storage') {
      return sendJson(res, 200, {
        database: { id: db.id, name: db.name },
        keys: stats.keyCount,
        memoryBytes: stats.memoryBytes,
        limits: { maxKeys: db.maxKeys, maxMemoryBytes: db.maxMemoryBytes, maxValueBytes: db.maxValueBytes },
      });
    }
    // kind === 'databases' + /data
    return sendJson(res, 200, { database: { id: db.id, name: db.name }, ...browseKeys(tdb.engine, 200) });
  }
}

/** Live, server-side key listing with type, value preview and TTL. */
function browseKeys(engine, limit = 200) {
  const keys = engine.keyspace.listLiveKeys ? engine.keyspace.listLiveKeys() : [];
  const total = keys.length;
  const shown = keys.slice(0, limit);
  const out = [];
  for (const k of shown) {
    const entry = engine.describeKey(k);
    if (!entry) continue;
    out.push(entry);
  }
  out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { total, keys: out };
}

module.exports = { WebApi, handleWeb, PAGES, browseKeys };
