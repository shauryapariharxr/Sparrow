'use strict';

const { Keyspace } = require('./store');
const { Core } = require('./commands_core');
const { Collections } = require('./commands_collections');

/** Internal per-tenant command surface. Everything is synchronous on purpose:
 *  the engine is single-threaded by design (same as Redis) and the HTTP layer
 *  is async around it. */
class Engine {
  constructor({ keyspace, limits, name, nowFn, rngFn }) {
    this.keyspace = keyspace || new Keyspace(name || 'default', limits, nowFn);
    this.limits = limits || {};
    this.name = name || this.keyspace.namespace;
    this._nowFn = nowFn || (() => Date.now());
    this._nowOverride = null; // set during AOF replay so relative TTLs replay faithfully
    this._rng = rngFn || Math.random;
    this.dirty = false;
    this.lastSaveMs = 0;
    // Command mixins (commands_core.js / commands_collections.js) are written
    // against `this.engine.*`; the engine is its own engine.
    this.engine = this;
  }

  now() { return this._nowOverride !== null ? this._nowOverride : this._nowFn(); }
  setNowOverride(ms) { this._nowOverride = ms; }
  clearNowOverride() { this._nowOverride = null; }
  rng() { return this._rng(); }
  markDirty() { this.dirty = true; }

  limitsInfo() {
    return {
      maxKeys: this.limits.maxKeys || 0,
      maxMemoryBytes: this.limits.maxMemoryBytes || 0,
      maxValueBytes: this.limits.maxValueBytes || 0,
    };
  }

  /** Lookup a key after lazy-expiring it (key must be a latin1 string). */
  liveValue(key) {
    this.keyspace.checkExpired(key);
    return this.keyspace.getValue(key);
  }

  /** Lazy expiry touch used by read paths (cheap, no allocation). */
  touch(key) {
    this.keyspace.checkExpired(key);
  }

  setString(key, buf, { keepttl = false } = {}) {
    const existing = this.liveValue(key);
    if (existing && existing.kind !== 'string') return { ok: false, error: 'WRONGTYPE' };
    const r = this.keyspace.setString(key, buf);
    if (!r.ok) return r;
    if (!keepttl && existing && existing.expireAtMs !== null) {
      this.keyspace.persistKey(key);
    }
    this.markDirty();
    return { ok: true };
  }

  appendString(key, buf) {
    const existing = this.liveValue(key);
    if (existing && existing.kind !== 'string') return { ok: false, error: 'WRONGTYPE' };
    const merged = existing ? Buffer.concat([existing.data, buf]) : buf;
    const r = this.keyspace.setString(key, merged);
    if (!r.ok) return r;
    this.markDirty();
    return { ok: true, total: merged.length };
  }

  applyStringRange(key, offset, buf) {
    const existing = this.liveValue(key);
    const old = existing && existing.kind === 'string' ? existing.data : Buffer.alloc(0);
    // Overwrite in place, zero-padding any gap beyond the current length.
    const left = old.slice(0, Math.min(offset, old.length));
    const end = offset + buf.length;
    const right = end < old.length ? old.slice(end) : Buffer.alloc(0);
    const pad = Buffer.alloc(Math.max(0, offset - left.length));
    const merged = Buffer.concat([left, pad, buf, right]);
    const r = this.keyspace.setString(key, merged);
    if (!r.ok) return r;
    this.markDirty();
    return { ok: true, total: merged.length };
  }

  cloneValue(v, destKey) {
    let data;
    if (v.kind === 'string') data = Buffer.from(v.data);
    else if (v.kind === 'list') data = v.data.map((b) => Buffer.from(b));
    else if (v.kind === 'set') data = new Set(v.data);
    else if (v.kind === 'hash') data = new Map(v.data);
    else data = { map: new Map(v.data.map), sorted: v.data.sorted.map((p) => [p[0], p[1]]) };
    const r = this.keyspace.createContainer(destKey, v.kind, data);
    if (!r.ok) return { ok: false, error: r.error };
    let extra = 0;
    if (v.kind === 'string') extra = v.data.length;
    else if (v.kind === 'list') for (const b of v.data) extra += 64 + b.length;
    else if (v.kind === 'set') for (const s of v.data) extra += 80 + s.length;
    else if (v.kind === 'hash') for (const [f, val] of v.data) extra += 64 + f.length + val.length;
    else if (v.kind === 'zset') for (const [m] of v.data.sorted) extra += 48 + m.length;
    if (extra > 0) this.keyspace.containerAddMemForce(r.value, extra);
    if (v.kind === 'string') r.value.mem += 0; // string payload already sized via extra
    if (v.expireAtMs !== null) this.keyspace.setExpire(destKey, v.expireAtMs);
    this.markDirty();
    return { ok: true };
  }

  tooLarge(n) {
    const max = this.limits.maxValueBytes || 0;
    return max > 0 && n > max;
  }

  quotaErr(code) {
    if (code === 'maxkeys') return { error: 'key limit reached for this database' };
    if (code === 'OOM') return { error: 'memory limit reached for this database' };
    if (code === 'value-too-large') return { error: 'value exceeds the maximum value size for this database' };
    return { error: String(code) };
  }

  wrongType() {
    return { error: 'WRONGTYPE Operation against a key holding the wrong kind of value' };
  }

  wrongArg(cmd) {
    return { error: `ERR wrong number of arguments for '${String(cmd).toLowerCase()}' command` };
  }

  getOrCreateList(key) {
    let v = this.liveValue(key);
    if (v && v.kind !== 'list') return { err: this.wrongType() };
    if (!v) {
      const c = this.keyspace.createContainer(key, 'list', []);
      if (!c.ok) return { err: this.quotaErr(c.error) };
      v = c.value;
    }
    return { v };
  }

  expireAllExpired() {
    return this.keyspace.expireCycle(this.now(), 10000);
  }

  /**
   * Execute a command (array of Buffers/strings) against this tenant keyspace.
   * Returns a Redis reply value:
   *   string (status/bulk), Buffer (bulk), number (int), null, array, {error}
   */
  execute(argv) {
    if (!Array.isArray(argv) || argv.length === 0) {
      return { error: 'ERR empty command' };
    }
    const name = String(argv[0]).toUpperCase();
    const args = argv.slice(1);
    if (INTERNAL.has(name)) return { error: `ERR unknown command '${name}'` };
    const fn = this[name];
    if (typeof fn !== 'function') {
      return { error: `ERR unknown command '${name}'` };
    }
    try {
      return fn.call(this, ...args);
    } catch (e) {
      return { error: `ERR internal: ${e.message}` };
    }
  }
}

// Attach command mixins (Core first, Collections overrides nothing in Core).
Object.assign(Engine.prototype, Core, Collections);

// Hide pseudo-commands from execute()'s dynamic lookup.
const HIDDEN = ['_incrBy', '_expire', '_push', '_pushX', '_popList', '_collectSets', 'applyStringRange',
  '_storeSetResult', '_zsetAdd', '_zsetMemberScore', '_ensureZset', '_zrangeReply',
  '_parseLexBound', '_zpop', '_zsetUnionInter', '_agg', '_parseWeightAgg', '_zstore',
  '_hIncr', 'limitsInfo', 'now', 'rng', 'markDirty', 'liveValue', 'touch', 'tooLarge',
  'quotaErr', 'wrongType', 'wrongArg', 'getOrCreateList', 'setString', 'appendString',
  'cloneValue', 'expireAllExpired', 'execute', 'constructor'];
for (const h of HIDDEN) {
  Object.defineProperty(Engine.prototype, h, { enumerable: false });
}

const INTERNAL = new Set(HIDDEN.map((h) => h.toUpperCase()));

module.exports = { Engine, Keyspace, INTERNAL_COMMANDS: INTERNAL };
