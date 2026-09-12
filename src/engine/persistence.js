'use strict';

/**
 * Persistence for one tenant database: append-only file (AOF) plus periodic
 * snapshot (RDB). Files live under <dataDir>/<dbId>/:
 *   appendonly.aof  - JSON lines, one per mutating command
 *   snapshot.rdb    - JSON snapshot written atomically (tmp + rename)
 *
 * Replay applies commands in order; the snapshot is loaded first, then the
 * AOF tail after its last snapshot seq. When the AOF grows past the
 * compaction threshold, a rewrite writes a fresh snapshot and truncates it.
 */

const fs = require('fs');
const path = require('path');
const { Value } = require('./store');

const AOF_FILENAME = 'appendonly.aof';
const RDB_FILENAME = 'snapshot.rdb';

function serializeValue(v) {
  const out = { kind: v.kind, expireAtMs: v.expireAtMs };
  switch (v.kind) {
    case 'string': out.data = v.data.toString('base64'); break;
    case 'list': out.data = v.data.map((b) => b.toString('base64')); break;
    case 'set': out.data = Array.from(v.data); break;
    case 'hash': out.data = Array.from(v.data, ([f, val]) => [f, val.toString('base64')]); break;
    case 'zset': out.data = v.data.sorted.map(([m, s]) => [m, s]); break;
    default: out.data = null;
  }
  return out;
}

function deserializeValue(rec) {
  const v = new Value(rec.kind, null);
  switch (rec.kind) {
    case 'string': v.data = Buffer.from(rec.data, 'base64'); v.mem = 64 + v.data.length; break;
    case 'list':
      v.data = rec.data.map((s) => Buffer.from(s, 'base64'));
      v.mem = 64;
      for (const b of v.data) v.mem += 64 + b.length;
      break;
    case 'set':
      v.data = new Set(rec.data);
      v.mem = 64;
      for (const s of rec.data) v.mem += 80 + s.length;
      break;
    case 'hash':
      v.data = new Map(rec.data.map(([f, b64]) => [f, Buffer.from(b64, 'base64')]));
      v.mem = 64;
      for (const [f, b] of v.data) v.mem += 64 + f.length + b.length;
      break;
    case 'zset': {
      const map = new Map();
      for (const [m, s] of rec.data) map.set(m, s);
      v.data = { map, sorted: rec.data.slice() };
      v.mem = 64;
      for (const [m] of rec.data) v.mem += 48 + m.length;
      break;
    }
    default: return null;
  }
  v.cost = 0;
  if (typeof rec.expireAtMs === 'number') v.expireAtMs = rec.expireAtMs;
  return v;
}

class Persistence {
  constructor(dbId, dataDir, engine, { aofEnabled = true, aofFsync = 'always' } = {}) {
    this.dbId = dbId;
    this.dir = path.join(dataDir, dbId);
    this.engine = engine;
    this.aofEnabled = aofEnabled;
    this.aofFsync = aofFsync;
    this.aofPath = path.join(this.dir, AOF_FILENAME);
    this.rdbPath = path.join(this.dir, RDB_FILENAME);
    this.aofSeq = 0;          // commands appended since open
    this.aofBytes = 0;
    this.fd = null;
    this.lastRewriteMs = Date.now();
    this.fsCache = null;
    this.dirty = false;
  }

  ensureDir() {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /** Load snapshot + AOF tail into the engine's keyspace. Returns stats. */
  load() {
    const engine = this.engine;
    let snapshotKeys = 0;
    let snapshotMarker = 0; // AOF entries already reflected in the snapshot
    if (fs.existsSync(this.rdbPath)) {
      try {
        const raw = fs.readFileSync(this.rdbPath, 'utf8');
        const snap = JSON.parse(raw);
        if (snap && snap.databases && typeof snap.databases === 'object') {
          snapshotMarker = Number.isFinite(snap.aofSeq) ? snap.aofSeq : 0;
          for (const [key, rec] of Object.entries(snap.databases)) {
            const v = deserializeValue(rec);
            if (!v) continue;
            engine.keyspace.map.set(key, v);
            engine.keyspace.stats.keyCount++;
            engine.keyspace.stats.memoryBytes += v.mem;
            if (v.expireAtMs !== null) engine.keyspace.expires.add(key);
            snapshotKeys++;
          }
        }
      } catch (e) {
        // Corrupt snapshot: fall back to full AOF replay rather than crash.
        snapshotMarker = 0;
        console.error(`[redex:persistence] snapshot load failed for ${this.dbId}: ${e.message}`);
      }
    }

    let aofCommands = 0;
    let aofEntries = 0;
    if (this.aofEnabled && fs.existsSync(this.aofPath)) {
      try {
        const raw = fs.readFileSync(this.aofPath, 'utf8');
        const lines = raw.split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          let entry;
          try { entry = JSON.parse(line); } catch { continue; }
          if (!entry || !Array.isArray(entry.cmd)) continue;
          aofEntries++;
          if (aofEntries <= snapshotMarker) continue; // already in the snapshot
          const ts = typeof entry.ts === 'number' ? entry.ts : Date.now();
          const prevOverride = engine._nowOverride;
          engine.setNowOverride(ts);
          try {
            engine.execute(entry.cmd.map((s) => Buffer.from(s, 'utf8')));
          } finally {
            engine._nowOverride = prevOverride !== undefined ? prevOverride : null;
          }
          aofCommands++;
        }
      } catch (e) {
        console.error(`[redex:persistence] AOF load failed for ${this.dbId}: ${e.message}`);
      }
    }

    // Drop already-expired keys after replay so stats start accurate.
    engine.expireAllExpired();
    // The AOF file on disk now contains aofEntries commands; appends continue
    // from there, so the running count must include the skipped prefix.
    this.aofSeq = aofEntries;
    return { snapshotKeys, aofCommands, skippedFromAof: Math.min(snapshotMarker, aofEntries) };
  }

  /** Append a mutating command to the AOF. argv is the original command array. */
  append(argv) {
    if (!this.aofEnabled) return;
    if (!Array.isArray(argv) || argv.length === 0) return;
    const cmd = argv.map((a) => (Buffer.isBuffer(a) ? a.toString('utf8') : String(a)));
    // Use the engine's clock (not wall time) so relative TTLs replay faithfully
    // even when the writer ran on a shifted test clock.
    const entry = JSON.stringify({ ts: this.engine.now(), cmd }) + '\n';
    const buf = Buffer.from(entry, 'utf8');
    if (this.fd === null) {
      this.ensureDir();
      this.fd = fs.openSync(this.aofPath, 'a');
    }
    fs.writeSync(this.fd, buf);
    if (this.aofFsync === 'always') fs.fsyncSync(this.fd);
    this.aofSeq++;
    this.aofBytes += buf.length;
  }

  shouldRewrite() {
    if (!this.aofEnabled) return false;
    if (this.aofBytes > 64 * 1024 * 1024) return true;
    return false;
  }

  /** Build the snapshot object; marker = how many AOF entries it already covers. */
  buildSnapshot(marker) {
    const engine = this.engine;
    const databases = {};
    const now = Date.now();
    for (const [key, v] of engine.keyspace.map) {
      if (engine.keyspace.isExpired(v, now)) continue;
      databases[key] = serializeValue(v);
    }
    return {
      version: 1,
      savedAt: now,
      dbId: this.dbId,
      aofSeq: marker,
      keyCount: Object.keys(databases).length,
      databases,
    };
  }

  /** Atomic snapshot write (tmp + rename). Marker = current AOF position. */
  saveRdb() {
    this.ensureDir();
    const snap = this.buildSnapshot(this.aofSeq);
    const tmp = this.rdbPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(snap));
    fs.renameSync(tmp, this.rdbPath);
    this.engine.dirty = false;
    this.dirty = false;
  }

  /**
   * Compact: write a fresh snapshot, then truncate the AOF. The staged
   * snapshot carries marker 0 because the AOF is emptied in the same
   * synchronous block (no command can interleave on Node's single thread).
   */
  rewrite() {
    this.ensureDir();
    const snap = this.buildSnapshot(0);
    const tmp = this.rdbPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(snap));
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
    fs.writeFileSync(this.aofPath, '');
    fs.renameSync(tmp, this.rdbPath);
    this.aofBytes = 0;
    this.aofSeq = 0;
    this.lastRewriteMs = Date.now();
    this.engine.dirty = false;
    this.dirty = false;
  }

  flush() {
    if (this.fd !== null) {
      try { fs.fsyncSync(this.fd); } catch { /* already closed */ }
    }
  }

  close() {
    if (this.fd !== null) {
      try { fs.closeSync(this.fd); this.fd = null; } catch { /* ignore */ }
    }
  }

  /** Delete all on-disk state for this database. */
  destroy() {
    this.close();
    try { fs.rmSync(this.dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

module.exports = { Persistence, AOF_FILENAME, RDB_FILENAME, serializeValue, deserializeValue };
