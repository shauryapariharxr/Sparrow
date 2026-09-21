'use strict';

const { byteLength } = require('../util');

// Value kinds: 'string' | 'list' | 'set' | 'zset' | 'hash'
// ZSet is modeled as: obj = Map<member, score>, plus a sorted view (lazy).
// All numeric bookkeeping lives on the Value wrapper.

let valueSeq = 0;

class Value {
  constructor(kind, data) {
    this.id = ++valueSeq;
    this.kind = kind; // 'string' | 'list' | 'set' | 'zset' | 'hash'
    this.data = data;
    this.expireAtMs = null; // null = no expiry
    // memory: for strings it's derived; for containers we track incrementally.
    this.mem = 0;
    this.cost = 0; // value-size bytes for quota (strings: byte length; others: rough count-based)
  }
}

function stringMem(buf) {
  // Buffer object overhead approximation + raw bytes
  return 64 + (buf ? buf.length : 0);
}

class Keyspace {
  /**
   * @param {string} namespace e.g. "db_ab12"
   * @param {object} limits { maxKeys, maxMemoryBytes, maxValueBytes }
   */
  constructor(namespace, limits, nowFn) {
    this.namespace = namespace;
    this.limits = limits || {};
    this.nowFn = nowFn || (() => Date.now());
    this.map = new Map(); // key (latin1 string) -> Value
    this.stats = {
      keyCount: 0,
      memoryBytes: 0,
      commandCount: 0,
      expiredCount: 0,
      evictedCount: 0,
    };
    this.expires = new Set(); // keys (string) that have expireAtMs set — secondary index for active expiry
  }

  sizeKey(k) {
    return 64 + byteLength(k);
  }

  addMem(v, delta) {
    v.mem += delta;
    this.stats.memoryBytes += delta;
  }

  setString(key, buf) {
    const existing = this.map.get(key);
    const newMem = stringMem(buf);
    const delta = existing ? newMem - existing.mem : newMem + this.sizeKey(key);
    if (this.limits.maxMemoryBytes && this.stats.memoryBytes + delta > this.limits.maxMemoryBytes) {
      return { ok: false, error: 'OOM' };
    }
    if (!existing && this.limits.maxKeys && this.map.size >= this.limits.maxKeys) {
      return { ok: false, error: 'maxkeys' };
    }
    if (existing) {
      this.addMem(existing, delta);
      existing.data = buf;
      existing.kind = 'string';
      existing.cost = buf.length;
    } else {
      const v = new Value('string', buf);
      v.mem = newMem;
      v.cost = buf.length;
      this.map.set(key, v);
      this.stats.keyCount++;
      this.stats.memoryBytes += newMem;
    }
    return { ok: true };
  }

  getString(key) {
    const v = this.map.get(key);
    if (!v || v.kind !== 'string') return null;
    return v.data;
  }

  getValue(key) {
    return this.map.get(key) || null;
  }

  createContainer(key, kind, data, initialMem) {
    if (this.limits.maxKeys && this.map.size >= this.limits.maxKeys) {
      return { ok: false, error: 'maxkeys' };
    }
    const mem = 64 + (initialMem || 0);
    if (this.limits.maxMemoryBytes && this.stats.memoryBytes + mem + this.sizeKey(key) > this.limits.maxMemoryBytes) {
      return { ok: false, error: 'OOM' };
    }
    const v = new Value(kind, data);
    v.mem = mem;
    this.map.set(key, v);
    this.stats.keyCount++;
    this.stats.memoryBytes += mem;
    return { ok: true, value: v };
  }

  containerAddMem(v, delta) {
    if (delta >= 0 && this.limits.maxMemoryBytes && this.stats.memoryBytes + delta > this.limits.maxMemoryBytes) {
      return false;
    }
    this.addMem(v, delta);
    return true;
  }

  /** Unconditional memory adjustment (for removals and internal rewrites). */
  containerAddMemForce(v, delta) {
    this.addMem(v, delta);
  }

  deleteKey(key) {
    const v = this.map.get(key);
    if (!v) return false;
    this.map.delete(key);
    this.stats.keyCount--;
    this.stats.memoryBytes -= v.mem;
    if (v.expireAtMs !== null) this.expires.delete(key);
    return true;
  }

  setExpire(key, ms) {
    const v = this.map.get(key);
    if (!v) return false;
    v.expireAtMs = ms;
    this.expires.add(key);
    return true;
  }

  persistKey(key) {
    const v = this.map.get(key);
    if (!v || v.expireAtMs === null) return false;
    v.expireAtMs = null;
    this.expires.delete(key);
    return true;
  }

  isExpired(v, now) {
    return v.expireAtMs !== null && v.expireAtMs <= now;
  }

  /** Remove an expired key; returns true if removed. */
  removeExpired(key, v) {
    this.map.delete(key);
    this.stats.keyCount--;
    this.stats.memoryBytes -= v.mem;
    this.expires.delete(key);
    this.stats.expiredCount++;
    return true;
  }

  /** Active expiry cycle: scan the expires index. Returns number removed. */
  expireCycle(now, maxScan = 200) {
    let removed = 0;
    for (const key of this.expires) {
      const v = this.map.get(key);
      if (!v) {
        this.expires.delete(key);
        continue;
      }
      if (v.expireAtMs !== null && v.expireAtMs <= now) {
        this.removeExpired(key, v);
        removed++;
      }
      if (removed >= maxScan) break;
    }
    return removed;
  }

  /** Lazy expiry check used by read/write paths. */
  checkExpired(key) {
    const v = this.map.get(key);
    if (v && this.isExpired(v, this.nowFn())) {
      this.removeExpired(key, v);
      return true;
    }
    return false;
  }

  /** Number of live (non-expired) keys — used by SCAN etc. Approximates redis dbsize. */
  liveKeyCount() {
    const now = this.nowFn();
    let n = 0;
    for (const [k, v] of this.map) {
      if (!this.isExpired(v, now)) n++;
    }
    return n;
  }

  /** Live (non-expired) keys as latin1 strings — read-only, used by introspection. */
  listLiveKeys() {
    const now = this.nowFn();
    const out = [];
    for (const [k, v] of this.map) {
      if (!this.isExpired(v, now)) out.push(k);
    }
    return out;
  }

  clear() {
    this.map.clear();
    this.expires.clear();
    this.stats.keyCount = 0;
    this.stats.memoryBytes = 0;
  }
}

module.exports = { Keyspace, Value };
