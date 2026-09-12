'use strict';

const fs = require('fs');
const path = require('path');
const { Engine } = require('./engine');
const { Persistence } = require('./persistence');
const { PubSub } = require('./pubsub');
const config = require('../config');

const CLEANUP_INTERVAL_MS = 1000;
const SNAPSHOT_INTERVAL_MS = 60_000;
const IDLE_UNLOAD_MS = 5 * 60_000;

/** One loaded tenant database. */
class TenantDb {
  constructor({ dbId, limits, aofEnabled, aofFsync, nowFn }) {
    this.dbId = dbId;
    this.engine = new Engine({ name: dbId, limits, nowFn });
    this.persistence = new Persistence(dbId, config.dataDir, this.engine, { aofEnabled, aofFsync });
    this.pubsub = new PubSub();
    this.engine.pubsub = this.pubsub; // PUBLISH needs the hub
    this.lastAccess = Date.now();
    this.loadedAt = Date.now();
    this.dirtySinceSnapshot = false;
  }

  touch() { this.lastAccess = Date.now(); }

  /** Dispatch a command; appends to AOF when it mutates state. */
  execute(argv) {
    this.touch();
    const before = this.engine.dirty;
    const reply = this.engine.execute(argv);
    const mutated = !before && this.engine.dirty;
    if (mutated) {
      this.persistence.append(argv);
      this.engine.dirty = false;
      this.dirtySinceSnapshot = true;
    }
    return reply;
  }

  snapshotIfDue() {
    if (this.dirtySinceSnapshot) {
      try { this.persistence.saveRdb(); this.dirtySinceSnapshot = false; } catch (e) {
        console.error(`[redex:tenant ${this.dbId}] snapshot failed: ${e.message}`);
      }
    }
  }
}

/**
 * TenantManager owns every loaded tenant database and drives the background
 * cycles (lazy-ish expiry sweep, periodic snapshot, AOF rewrite check).
 */
class TenantManager {
  constructor({ aofEnabled, aofFsync, nowFn } = {}) {
    this.tenants = new Map();
    this.aofEnabled = aofEnabled !== undefined ? aofEnabled : config.aofEnabled;
    this.aofFsync = aofFsync || config.aofFsync;
    this._nowFn = nowFn || (() => Date.now());
    this._timer = null;
    this.stats = { totalCommands: 0, loadedTenants: 0, startedAt: Date.now() };
  }

  _loop() {
    const now = Date.now();
    for (const [dbId, tdb] of this.tenants) {
      try {
        tdb.engine.expireAllExpired();
        tdb.snapshotIfDue();
        if (tdb.persistence.shouldRewrite()) {
          tdb.persistence.rewrite();
        }
        if (now - tdb.lastAccess > IDLE_UNLOAD_MS && !tdb.dirtySinceSnapshot) {
          tdb.persistence.close();
          this.tenants.delete(dbId);
        }
      } catch (e) {
        console.error(`[redex:tenant ${dbId}] background cycle error: ${e.message}`);
      }
    }
    this.stats.loadedTenants = this.tenants.size;
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._loop(), CLEANUP_INTERVAL_MS);
    this._timer.unref();
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this.flushAll();
  }

  /** Get or lazily load a tenant database. */
  get(dbId, limits) {
    let tdb = this.tenants.get(dbId);
    if (tdb) {
      tdb.touch();
      return tdb;
    }
    tdb = new TenantDb({
      dbId,
      limits,
      aofEnabled: this.aofEnabled,
      aofFsync: this.aofFsync,
      nowFn: this._nowFn,
    });
    const st = tdb.persistence.load();
    this.tenants.set(dbId, tdb);
    this.stats.loadedTenants = this.tenants.size;
    if (st.aofCommands > 0 || st.snapshotKeys > 0) {
      console.log(`[redex:tenant ${dbId}] loaded ${st.snapshotKeys} keys from snapshot, ${st.aofCommands} AOF commands`);
    }
    return tdb;
  }

  /** Persist everything now (used on shutdown and before tests finish). */
  flushAll() {
    for (const tdb of this.tenants.values()) tdb.snapshotIfDue();
  }

  /** Global usage across loaded tenants. */
  globalStats() {
    let keys = 0;
    let memory = 0;
    for (const tdb of this.tenants.values()) {
      keys += tdb.engine.keyspace.stats.keyCount;
      memory += tdb.engine.keyspace.stats.memoryBytes;
    }
    return { keys, memory, loadedTenants: this.tenants.size };
  }

  /** Create a fresh, empty tenant (used when a database is provisioned). */
  create(dbId, limits) {
    const tdb = this.get(dbId, limits);
    return tdb;
  }

  /** Permanently remove a tenant and its files. */
  destroy(dbId) {
    const tdb = this.tenants.get(dbId);
    if (tdb) {
      tdb.persistence.destroy();
      this.tenants.delete(dbId);
      tdb.pubsub.clear();
    } else {
      // Not loaded; just remove files.
      const dir = path.join(config.dataDir, dbId);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}

module.exports = { TenantManager, TenantDb, SNAPSHOT_INTERVAL_MS };
