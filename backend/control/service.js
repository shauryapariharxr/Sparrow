'use strict';

const crypto = require('crypto');
const config = require('../config');
const { ControlStore } = require('./store');
const { generateToken, sha256hex, constantTimeEqual, randomId } = require('../util');

const SCRYPT_N = 16384, SCRYPT_R = 8, SCRYPT_P = 1, KEYLEN = 64;

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }).toString('hex');
}

function dayString(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10);
}

class ControlService {
  constructor({ store, limits } = {}) {
    this.store = store || new ControlStore(config.sqlitePath);
    this.limits = {
      maxKeys: limits?.maxKeys ?? config.maxKeys,
      maxMemoryBytes: limits?.maxMemoryBytes ?? config.maxMemoryBytes,
      maxValueBytes: limits?.maxValueBytes ?? config.maxValueBytes,
    };
    this.maxDbPerUser = limits?.maxDbPerUser ?? config.maxDbPerUser;
    // tokenHash -> { dbId, readonly, checkedAt }
    this._tokenCache = new Map();
    this.TOKEN_CACHE_TTL_MS = 10_000;
    this._sessionGcTimer = null;
    this.purgeExpiredSessions();
  }

  /** Hourly GC: expired sessions linger forever unless presented again. */
  purgeExpiredSessions() {
    try { this.store.purgeExpiredSessions(); } catch { /* non-fatal */ }
  }

  startSessionGc(intervalMs = 60 * 60 * 1000) {
    if (this._sessionGcTimer) return;
    this._sessionGcTimer = setInterval(() => this.purgeExpiredSessions(), intervalMs);
    this._sessionGcTimer.unref();
  }

  stopSessionGc() {
    if (this._sessionGcTimer) { clearInterval(this._sessionGcTimer); this._sessionGcTimer = null; }
  }

  // ── users & sessions ────────────────────────────────────────────
  signup(email, password) {
    email = String(email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { err: { status: 400, code: 'invalid_email', message: 'Enter a valid email address.' } };
    }
    if (typeof password !== 'string' || password.length < 8) {
      return { err: { status: 400, code: 'weak_password', message: 'Password must be at least 8 characters.' } };
    }
    if (this.store.getUserByEmail(email)) {
      return { err: { status: 409, code: 'email_taken', message: 'An account with this email already exists.' } };
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const user = {
      id: `user_${randomId(16)}`,
      email,
      salt,
      passwordHash: hashPassword(password, salt),
      createdAt: Date.now(),
    };
    this.store.createUser(user);
    return { user };
  }

  login(email, password) {
    email = String(email || '').trim().toLowerCase();
    const user = this.store.getUserByEmail(email);
    if (!user) return { err: { status: 401, code: 'invalid_credentials', message: 'Invalid email or password.' } };
    const attempt = Buffer.from(hashPassword(password, user.salt), 'hex');
    const actual = Buffer.from(user.passwordHash, 'hex');
    const ok = attempt.length === actual.length && crypto.timingSafeEqual(attempt, actual);
    if (!ok) return { err: { status: 401, code: 'invalid_credentials', message: 'Invalid email or password.' } };
    return { user };
  }

  createSession(userId) {
    const token = `sess_${randomId(48)}`;
    const now = Date.now();
    const session = { token, userId, createdAt: now, expiresAt: now + config.sessionTtlHours * 3600 * 1000 };
    this.store.createSession(session);
    return session;
  }

  validateSession(token) {
    if (!token || !token.startsWith('sess_')) return null;
    return this.store.getSession(token);
  }

  logout(token) {
    this.store.deleteSession(token);
  }

  // ── databases ───────────────────────────────────────────────────
  createDatabase(userId, name) {
    name = String(name || '').trim();
    if (!name || name.length > config.maxDbName) {
      return { err: { status: 400, code: 'invalid_name', message: `Database name must be 1-${config.maxDbName} characters.` } };
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) {
      return { err: { status: 400, code: 'invalid_name', message: 'Use letters, numbers, dashes and underscores only.' } };
    }
    if (this.store.countUserDatabases(userId) >= this.maxDbPerUser) {
      return { err: { status: 402, code: 'too_many_databases', message: `Free plan limit: ${this.maxDbPerUser} databases.` } };
    }
    const db = {
      id: `db_${randomId(16)}`,
      userId,
      name,
      createdAt: Date.now(),
      maxKeys: this.limits.maxKeys,
      maxMemoryBytes: this.limits.maxMemoryBytes,
      maxValueBytes: this.limits.maxValueBytes,
    };
    this.store.createDatabase(db);
    return { db };
  }

  getDatabase(dbId) { return this.store.getDatabase(dbId); }
  listDatabases(userId) { return this.store.listDatabasesByUser(userId); }

  deleteDatabase(dbId) {
    this.store.deleteDatabase(dbId);
    for (const [hash, entry] of this._tokenCache) {
      if (entry.dbId === dbId) this._tokenCache.delete(hash);
    }
  }

  // ── tokens ──────────────────────────────────────────────────────
  createToken(dbId, { name = 'default', readonly = false } = {}) {
    const raw = generateToken();
    const token = {
      id: `tok_${randomId(12)}`,
      dbId,
      tokenHash: sha256hex(raw),
      prefix: raw.slice(0, 11),
      name: String(name || 'default').slice(0, 64),
      readonly: !!readonly,
      createdAt: Date.now(),
    };
    this.store.createToken(token);
    return { token, plaintext: raw };
  }

  listTokens(dbId) {
    return this.store.listTokensByDb(dbId).map((t) => ({
      id: t.id, name: t.name, prefix: t.prefix, readonly: t.readonly, createdAt: t.createdAt,
    }));
  }

  revokeToken(dbId, tokenId) {
    const tokens = this.store.listTokensByDb(dbId);
    const t = tokens.find((x) => x.id === tokenId);
    if (!t) return false;
    this.store.revokeToken(tokenId);
    this._tokenCache.delete(t.tokenHash);
    return true;
  }

  /** Resolve an API bearer token to its tenant database. Cached briefly. */
  authenticateApiToken(rawToken) {
    if (typeof rawToken !== 'string' || !rawToken.startsWith('sparrow_')) return null;
    const hash = sha256hex(rawToken);
    const cached = this._tokenCache.get(hash);
    const now = Date.now();
    if (cached && now - cached.checkedAt < this.TOKEN_CACHE_TTL_MS) {
      const db = this.store.getDatabase(cached.dbId);
      return db ? { db, readonly: cached.readonly } : null;
    }
    const row = this.store.getTokenByHash(hash);
    if (!row) return null;
    const db = this.store.getDatabase(row.dbId);
    if (!db) return null;
    this._tokenCache.set(hash, { dbId: row.dbId, readonly: row.readonly, checkedAt: now });
    return { db, readonly: row.readonly };
  }

  bumpUsage(dbId, delta = 1) {
    try { this.store.incrementUsage(dbId, dayString(), delta); } catch { /* non-fatal */ }
  }

  getUsageSummary(dbId) {
    return {
      today: this.store.getUsage(dbId, dayString()),
      history: this.store.listUsage(dbId, 14),
    };
  }

  close() {
    this._tokenCache.clear();
    this.store.close();
  }
}

module.exports = { ControlService, dayString };
