'use strict';

const { asBuffer } = require('../util');
const { isInt, toInt, isFloat, globToRegex, normKey } = require('./cmdutil');

/** Mixin: string commands, keyspace ops, expiry. All key args go through normKey. */
const Core = {
  // ───────────────────────── strings ─────────────────────────
  GET(key) {
    const v = this.liveValue(normKey(key));
    if (!v) return null;
    if (v.kind !== 'string') return this.wrongType();
    return v.data;
  },

  SET(key, value, ...rest) {
    const k = normKey(key);
    const vb = asBuffer(value == null ? '' : value);
    if (this.tooLarge(vb.length)) return this.quotaErr('value-too-large');
    let exMs = null;
    let keepttl = false;
    for (let i = 0; i < rest.length; i++) {
      const opt = String(rest[i]).toUpperCase();
      if (opt === 'EX' || opt === 'PX' || opt === 'EXAT' || opt === 'PXAT') {
        const n = toInt(rest[++i]);
        if (!Number.isFinite(n)) return { error: 'ERR value is not an integer or out of range' };
        const now = this.now();
        if (opt === 'EX') exMs = now + n * 1000;
        else if (opt === 'PX') exMs = now + n;
        else if (opt === 'EXAT') exMs = n * 1000;
        else exMs = n;
        if (exMs <= now) return { error: "ERR invalid expire time in 'set' command" };
      } else if (opt === 'KEEPTTL') {
        keepttl = true;
      } else if (opt === 'NX' || opt === 'XX') {
        const existing = this.liveValue(k);
        if ((opt === 'NX' && existing) || (opt === 'XX' && !existing)) return null;
      } else if (opt === 'GET') {
        return { error: 'ERR syntax error (GET option of SET is not supported)' };
      } else {
        return { error: `ERR syntax error '${rest[i]}'` };
      }
    }
    const r = this.engine.setString(k, vb, { keepttl });
    if (!r.ok) return this.quotaErr(r.error);
    if (exMs !== null) this.engine.keyspace.setExpire(k, exMs);
    return 'OK';
  },

  GETDEL(key) {
    const k = normKey(key);
    const v = this.liveValue(k);
    if (!v) return null;
    if (v.kind !== 'string') return this.wrongType();
    this.engine.keyspace.deleteKey(k);
    this.engine.markDirty();
    return v.data;
  },

  APPEND(key, value) {
    const k = normKey(key);
    const vb = asBuffer(value);
    const existing = this.liveValue(k);
    if (existing && existing.kind !== 'string') return this.wrongType();
    if (this.tooLarge(vb.length + (existing ? existing.data.length : 0))) return this.quotaErr('value-too-large');
    const r = this.engine.appendString(k, vb);
    if (!r.ok) return this.quotaErr(r.error);
    return r.total;
  },

  STRLEN(key) {
    const v = this.liveValue(normKey(key));
    if (!v) return 0;
    if (v.kind !== 'string') return this.wrongType();
    return v.data.length;
  },

  GETRANGE(key, start, end) {
    const v = this.liveValue(normKey(key));
    if (!v) return Buffer.alloc(0);
    if (v.kind !== 'string') return this.wrongType();
    if (!isInt(start) || !isInt(end)) return { error: 'ERR value is not an integer or out of range' };
    const data = v.data;
    const len = data.length;
    let s = toInt(start); let e = toInt(end);
    if (s < 0) s = len + s;
    if (e < 0) e = len + e;
    if (s < 0) s = 0;
    if (e >= len) e = len - 1;
    if (len === 0 || s > e || s >= len) return Buffer.alloc(0);
    return data.slice(s, e + 1);
  },

  SETRANGE(key, offset, value) {
    if (!isInt(offset) || toInt(offset) < 0) return { error: 'ERR value is not an integer or out of range' };
    const off = toInt(offset);
    const vb = asBuffer(value);
    const k = normKey(key);
    const existing = this.liveValue(k);
    if (existing && existing.kind !== 'string') return this.wrongType();
    if (off + vb.length > this.engine.limits.maxValueBytes) return this.quotaErr('value-too-large');
    const r = this.engine.applyStringRange(k, off, vb);
    if (!r.ok) return this.quotaErr(r.error);
    return r.total;
  },

  INCR(key) { return this._incrBy(normKey(key), 1); },
  DECR(key) { return this._incrBy(normKey(key), -1); },

  INCRBY(key, by) {
    if (!isInt(by)) return { error: 'ERR value is not an integer or out of range' };
    return this._incrBy(normKey(key), toInt(by));
  },

  DECRBY(key, by) {
    if (!isInt(by)) return { error: 'ERR value is not an integer or out of range' };
    return this._incrBy(normKey(key), -toInt(by));
  },

  _incrBy(key, delta) {
    const v = this.liveValue(key);
    if (v && v.kind !== 'string') return this.wrongType();
    if (v) {
      const s = v.data.toString('utf8');
      if (!/^-?\d+$/.test(s) || s.length > 18) return { error: 'ERR value is not an integer or out of range' };
      const next = Number(s) + delta;
      if (!Number.isSafeInteger(next)) return { error: 'ERR increment or decrement would overflow' };
      const r = this.engine.setString(key, Buffer.from(String(next), 'utf8'), { keepttl: true });
      if (!r.ok) return this.quotaErr(r.error);
      return next;
    }
    if (!Number.isSafeInteger(delta)) return { error: 'ERR increment or decrement would overflow' };
    const r = this.engine.setString(key, Buffer.from(String(delta), 'utf8'));
    if (!r.ok) return this.quotaErr(r.error);
    return delta;
  },

  INCRBYFLOAT(key, by) {
    if (!isFloat(by)) return { error: 'ERR value is not a valid float' };
    const f = Number(by);
    const key2 = normKey(key);
    const v = this.liveValue(key2);
    if (v && v.kind !== 'string') return this.wrongType();
    let cur = 0;
    if (v) {
      const s = v.data.toString('utf8');
      if (!isFloat(s)) return { error: 'ERR value is not a valid float' };
      cur = Number(s);
    }
    const next = cur + f;
    if (!Number.isFinite(next)) return { error: 'ERR increment would produce NaN or Infinity' };
    let out = next.toFixed(17);
    out = out.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
    const r = this.engine.setString(key2, Buffer.from(out, 'utf8'), { keepttl: true });
    if (!r.ok) return this.quotaErr(r.error);
    return out;
  },

  MGET(...keys) {
    return keys.map((k) => {
      const v = this.liveValue(normKey(k));
      return v && v.kind === 'string' ? v.data : null;
    });
  },

  MSET(...args) {
    if (args.length === 0 || args.length % 2 !== 0) return this.wrongArg('mset');
    for (let i = 0; i < args.length; i += 2) {
      if (this.tooLarge(asBuffer(args[i + 1]).length)) return this.quotaErr('value-too-large');
    }
    for (let i = 0; i < args.length; i += 2) {
      const r = this.engine.setString(normKey(args[i]), asBuffer(args[i + 1]), {});
      if (!r.ok) return this.quotaErr(r.error);
    }
    return 'OK';
  },

  MSETNX(...args) {
    if (args.length === 0 || args.length % 2 !== 0) return this.wrongArg('msetnx');
    for (let i = 0; i < args.length; i += 2) {
      if (this.liveValue(normKey(args[i]))) return 0;
    }
    for (let i = 0; i < args.length; i += 2) {
      const r = this.engine.setString(normKey(args[i]), asBuffer(args[i + 1]), {});
      if (!r.ok) return this.quotaErr(r.error);
    }
    return 1;
  },

  SETNX(key, value) {
    const k = normKey(key);
    if (this.liveValue(k)) return 0;
    const r = this.SET(k, value, 'NX');
    if (r && typeof r === 'object' && r.error) return r;
    return 1;
  },

  SETEX(key, seconds, value) {
    const n = toInt(seconds);
    if (!Number.isFinite(n) || n <= 0) return { error: "ERR invalid expire time in 'setex' command" };
    return this.SET(normKey(key), value, 'EX', seconds);
  },

  PSETEX(key, ms, value) {
    const n = toInt(ms);
    if (!Number.isFinite(n) || n <= 0) return { error: "ERR invalid expire time in 'psetex' command" };
    return this.SET(normKey(key), value, 'PX', ms);
  },

  GETSET(key, value) {
    const k = normKey(key);
    const vb = asBuffer(value);
    if (this.tooLarge(vb.length)) return this.quotaErr('value-too-large');
    const v = this.liveValue(k);
    const old = v && v.kind === 'string' ? v.data : null;
    if (v && v.kind !== 'string') return this.wrongType();
    const r = this.engine.setString(k, vb, {});
    if (!r.ok) return this.quotaErr(r.error);
    return old;
  },

  // ───────────────────────── keyspace ─────────────────────────
  DEL(...keys) {
    let n = 0;
    for (const k of keys) {
      if (this.engine.keyspace.deleteKey(normKey(k))) n++;
    }
    if (n > 0) this.engine.markDirty();
    return n;
  },

  UNLINK(...keys) { return this.DEL(...keys); },

  EXISTS(...keys) {
    let n = 0;
    for (const k of keys) {
      if (this.liveValue(normKey(k))) n++;
    }
    return n;
  },

  TYPE(key) {
    const v = this.liveValue(normKey(key));
    return v ? v.kind : 'none';
  },

  KEYS(pattern) {
    const rx = globToRegex(pattern ? pattern.toString('utf8') : '*');
    this.engine.expireAllExpired();
    const now = this.now();
    const out = [];
    for (const [k, v] of this.engine.keyspace.map) {
      if (this.engine.keyspace.isExpired(v, now)) continue;
      if (rx.test(k)) out.push(Buffer.from(k, 'latin1'));
    }
    return out;
  },

  SCAN(cursor, ...args) {
    if (args.length % 2 !== 0) return { error: 'ERR syntax error' };
    const opts = {};
    for (let i = 0; i < args.length; i += 2) {
      opts[String(args[i]).toUpperCase()] = args[i + 1].toString('utf8');
    }
    if (opts.TYPE && !['string', 'list', 'set', 'zset', 'hash'].includes(opts.TYPE)) {
      return { error: 'ERR invalid TYPE' };
    }
    const start = Number.parseInt(String(cursor), 10);
    if (!Number.isFinite(start) || start < 0) return { error: 'ERR invalid cursor' };
    const rx = opts.MATCH ? globToRegex(opts.MATCH) : null;
    this.engine.expireAllExpired();
    const now = this.now();
    const keys = [];
    for (const [k, v] of this.engine.keyspace.map) {
      if (this.engine.keyspace.isExpired(v, now)) continue;
      if (opts.TYPE && v.kind !== opts.TYPE) continue;
      if (rx && !rx.test(k)) continue;
      keys.push(k);
    }
    keys.sort();
    const count = Math.max(1, Number.parseInt(opts.COUNT || '100', 10) || 100);
    const slice = keys.slice(start, start + count);
    const next = start + count >= keys.length ? 0 : start + count;
    return [Buffer.from(String(next), 'utf8'), slice.map((k) => Buffer.from(k, 'latin1'))];
  },

  RANDOMKEY() {
    this.engine.expireAllExpired();
    const now = this.now();
    const live = [];
    for (const [k, v] of this.engine.keyspace.map) {
      if (!this.engine.keyspace.isExpired(v, now)) live.push(k);
    }
    if (live.length === 0) return null;
    return Buffer.from(live[Math.floor(this.engine.rng() * live.length)], 'latin1');
  },

  RENAME(key, newkey) {
    const k = normKey(key);
    const nk = normKey(newkey);
    const v = this.liveValue(k);
    if (!v) return { error: 'ERR no such key' };
    if (k === nk) return 'OK';
    this.engine.keyspace.deleteKey(nk);
    this.engine.keyspace.deleteKey(k);
    v.mem += this.engine.keyspace.sizeKey(nk) - this.engine.keyspace.sizeKey(k);
    this.engine.keyspace.map.set(nk, v);
    if (v.expireAtMs !== null) {
      this.engine.keyspace.expires.delete(k);
      this.engine.keyspace.expires.add(nk);
    }
    this.engine.markDirty();
    return 'OK';
  },

  RENAMENX(key, newkey) {
    const k = normKey(key);
    const v = this.liveValue(k);
    if (!v) return { error: 'ERR no such key' };
    if (this.liveValue(normKey(newkey))) return 0;
    const r = this.RENAME(k, normKey(newkey));
    if (r && typeof r === 'object' && r.error) return r;
    return 1;
  },

  COPY(src, dst, ...rest) {
    const replace = rest.some((r) => String(r).toUpperCase() === 'REPLACE');
    const sk = normKey(src);
    const v = this.liveValue(sk);
    if (!v) return 0;
    const dk = normKey(dst);
    if (this.liveValue(dk) && !replace) return 0;
    this.engine.keyspace.deleteKey(dk);
    const clone = this.engine.cloneValue(v, dk);
    if (!clone.ok) return this.quotaErr(clone.error);
    return 1;
  },

  DBSIZE() {
    this.engine.expireAllExpired();
    return this.engine.keyspace.liveKeyCount();
  },

  FLUSHDB() {
    this.engine.keyspace.clear();
    this.engine.markDirty();
    return 'OK';
  },

  FLUSHALL() { return this.FLUSHDB(); },

  // ───────────────────────── expiry ─────────────────────────
  TTL(key) {
    const v = this.liveValue(normKey(key));
    if (!v) return -2;
    if (v.expireAtMs === null) return -1;
    const ms = v.expireAtMs - this.now();
    return ms > 0 ? Math.ceil(ms / 1000) : -2;
  },

  PTTL(key) {
    const v = this.liveValue(normKey(key));
    if (!v) return -2;
    if (v.expireAtMs === null) return -1;
    const ms = v.expireAtMs - this.now();
    return ms > 0 ? ms : -2;
  },

  EXPIRE(key, seconds, ...rest) { return this._expire(normKey(key), seconds, 's', rest); },
  PEXPIRE(key, ms, ...rest) { return this._expire(normKey(key), ms, 'ms', rest); },
  EXPIREAT(key, s, ...rest) { return this._expire(normKey(key), s, 'at-s', rest); },
  PEXPIREAT(key, ms, ...rest) { return this._expire(normKey(key), ms, 'at-ms', rest); },

  _expire(key, amountStr, unit, rest) {
    const amount = toInt(amountStr);
    if (!Number.isFinite(amount)) return { error: 'ERR value is not an integer or out of range' };
    let flag = null;
    for (const r of rest) {
      const f = String(r).toUpperCase();
      if (['NX', 'XX', 'GT', 'LT'].includes(f)) flag = f;
      else return { error: `ERR syntax error '${r}'` };
    }
    const v = this.liveValue(key);
    if (!v) return 0;
    const now = this.now();
    let target;
    if (unit === 's') target = now + amount * 1000;
    else if (unit === 'ms') target = now + amount;
    else if (unit === 'at-s') target = amount * 1000;
    else target = amount;
    if (flag === 'NX' && v.expireAtMs !== null) return 0;
    if (flag === 'XX' && v.expireAtMs === null) return 0;
    if (flag === 'GT' && (v.expireAtMs === null || target <= v.expireAtMs)) return 0;
    if (flag === 'LT' && (v.expireAtMs === null || target >= v.expireAtMs)) return 0;
    this.engine.keyspace.setExpire(key, target);
    this.engine.markDirty();
    return 1;
  },

  PERSIST(key) {
    const k = normKey(key);
    const v = this.liveValue(k);
    if (!v || v.expireAtMs === null) return 0;
    this.engine.keyspace.persistKey(k);
    this.engine.markDirty();
    return 1;
  },

  // ───────────────────────── server ─────────────────────────
  PING(...args) {
    if (args.length > 1) return this.wrongArg('ping');
    return args.length === 1 ? args[0] : 'PONG';
  },

  ECHO(msg) { return asBuffer(msg); },

  TIME() {
    const now = this.now();
    return [Buffer.from(String(Math.floor(now / 1000)), 'utf8'), Buffer.from(String(now % 1000).padStart(6, '0'), 'utf8')];
  },

  SELECT() { return 'OK'; },

  PUBLISH(channel, message) {
    if (!this.engine.pubsub) return 0;
    return this.engine.pubsub.publish(
      channel.toString('utf8'),
      Buffer.isBuffer(message) ? message : Buffer.from(String(message), 'utf8'),
    );
  },

  CLIENT(...args) {
    const sub = String(args[0] || '').toUpperCase();
    if (sub === 'GETNAME') return Buffer.alloc(0);
    return 'OK';
  },
};

module.exports = { Core };
