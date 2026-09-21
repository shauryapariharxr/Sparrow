'use strict';

/**
 * Control-plane store backed by node:sqlite (WAL mode).
 * Tables: users, sessions, databases, api_tokens, usage_daily.
 */

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

class ControlStore {
  constructor(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        salt TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS databases (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        max_keys INTEGER NOT NULL DEFAULT 0,
        max_memory_bytes INTEGER NOT NULL DEFAULT 0,
        max_value_bytes INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS api_tokens (
        id TEXT PRIMARY KEY,
        db_id TEXT NOT NULL,
        token_hash TEXT UNIQUE NOT NULL,
        prefix TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT 'default',
        readonly INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS usage_daily (
        db_id TEXT NOT NULL,
        day TEXT NOT NULL,
        commands INTEGER NOT NULL DEFAULT 0,
        read_errors INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (db_id, day)
      );
      CREATE INDEX IF NOT EXISTS idx_tokens_db ON api_tokens(db_id);
      CREATE INDEX IF NOT EXISTS idx_databases_user ON databases(user_id);
    `);
    this._stmtCache = new Map();
  }

  prepare(sql) {
    let s = this._stmtCache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this._stmtCache.set(sql, s);
    }
    return s;
  }

  // ── users ───────────────────────────────────────────────────────
  createUser(user) {
    this.prepare('INSERT INTO users (id, email, password_hash, salt, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(user.id, user.email, user.passwordHash, user.salt, user.createdAt);
  }

  getUserByEmail(email) {
    const row = this.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
    return row ? this._mapUser(row) : null;
  }

  getUserById(id) {
    const row = this.prepare('SELECT * FROM users WHERE id = ?').get(id);
    return row ? this._mapUser(row) : null;
  }

  _mapUser(row) {
    return { id: row.id, email: row.email, passwordHash: row.password_hash, salt: row.salt, createdAt: row.created_at };
  }

  // ── sessions ────────────────────────────────────────────────────
  createSession(session) {
    this.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(session.token, session.userId, session.createdAt, session.expiresAt);
  }

  getSession(token) {
    const row = this.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
    if (!row) return null;
    if (row.expires_at <= Date.now()) {
      this.prepare('DELETE FROM sessions WHERE token = ?').run(token);
      return null;
    }
    return { token: row.token, userId: row.user_id, createdAt: row.created_at, expiresAt: row.expires_at };
  }

  deleteSession(token) {
    this.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }

  purgeExpiredSessions() {
    this.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
  }

  // ── databases ───────────────────────────────────────────────────
  createDatabase(db) {
    this.prepare(`INSERT INTO databases (id, user_id, name, created_at, max_keys, max_memory_bytes, max_value_bytes)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(db.id, db.userId, db.name, db.createdAt, db.maxKeys, db.maxMemoryBytes, db.maxValueBytes);
  }

  listDatabasesByUser(userId) {
    return this.prepare('SELECT * FROM databases WHERE user_id = ? ORDER BY created_at DESC')
      .all(userId).map((r) => this._mapDb(r));
  }

  getDatabase(id) {
    const row = this.prepare('SELECT * FROM databases WHERE id = ?').get(id);
    return row ? this._mapDb(row) : null;
  }

  countUserDatabases(userId) {
    const row = this.prepare('SELECT COUNT(*) AS n FROM databases WHERE user_id = ?').get(userId);
    return row ? row.n : 0;
  }

  deleteDatabase(id) {
    this.prepare('DELETE FROM databases WHERE id = ?').run(id);
    this.prepare('DELETE FROM api_tokens WHERE db_id = ?').run(id);
    this.prepare('DELETE FROM usage_daily WHERE db_id = ?').run(id);
  }

  _mapDb(row) {
    return {
      id: row.id,
      userId: row.user_id,
      name: row.name,
      createdAt: row.created_at,
      maxKeys: row.max_keys,
      maxMemoryBytes: row.max_memory_bytes,
      maxValueBytes: row.max_value_bytes,
    };
  }

  // ── tokens ──────────────────────────────────────────────────────
  createToken(token) {
    this.prepare(`INSERT INTO api_tokens (id, db_id, token_hash, prefix, name, readonly, created_at, revoked_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`)
      .run(token.id, token.dbId, token.tokenHash, token.prefix, token.name, token.readonly ? 1 : 0, token.createdAt);
  }

  getTokenByHash(tokenHash) {
    const row = this.prepare('SELECT * FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL').get(tokenHash);
    return row ? this._mapToken(row) : null;
  }

  listTokensByDb(dbId) {
    return this.prepare('SELECT * FROM api_tokens WHERE db_id = ? AND revoked_at IS NULL ORDER BY created_at DESC')
      .all(dbId).map((r) => this._mapToken(r));
  }

  countTokensByDb(dbId) {
    const row = this.prepare('SELECT COUNT(*) AS n FROM api_tokens WHERE db_id = ? AND revoked_at IS NULL').get(dbId);
    return row ? row.n : 0;
  }

  revokeToken(id) {
    this.prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(Date.now(), id);
  }

  _mapToken(row) {
    return {
      id: row.id,
      dbId: row.db_id,
      tokenHash: row.token_hash,
      prefix: row.prefix,
      name: row.name,
      readonly: !!row.readonly,
      createdAt: row.created_at,
      revokedAt: row.revoked_at,
    };
  }

  // ── usage ───────────────────────────────────────────────────────
  incrementUsage(dbId, day, delta = 1) {
    this.prepare(`INSERT INTO usage_daily (db_id, day, commands) VALUES (?, ?, ?)
                  ON CONFLICT(db_id, day) DO UPDATE SET commands = commands + ?`)
      .run(dbId, day, delta, delta);
  }

  getUsage(dbId, day) {
    const row = this.prepare('SELECT commands FROM usage_daily WHERE db_id = ? AND day = ?').get(dbId, day);
    return row ? row.commands : 0;
  }

  listUsage(dbId, days = 14) {
    return this.prepare('SELECT day, commands FROM usage_daily WHERE db_id = ? ORDER BY day DESC LIMIT ?')
      .all(dbId, days).map((r) => ({ day: r.day, commands: r.commands }));
  }

  close() {
    try { this.db.close(); } catch { /* ignore */ }
  }
}

module.exports = { ControlStore };
