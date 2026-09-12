'use strict';

const { asBuffer } = require('../util');
const {
  toInt, isInt, bufEq, parseScore, parseBound, formatScore,
  sortedUpsert, sortedRemove, comparePairs, normKey,
} = require('./cmdutil');

/** Mixin: list, set, zset and hash commands. All key args go through normKey. */
const Collections = {
  // ───────────────────────── lists ─────────────────────────
  LPUSH(key, ...values) {
    return this._push(normKey(key), values, 'left');
  },

  RPUSH(key, ...values) {
    return this._push(normKey(key), values, 'right');
  },

  _push(key, values, side) {
    if (values.length === 0) return this.wrongArg('push');
    for (const val of values) {
      if (this.tooLarge(asBuffer(val).length)) return this.quotaErr('value-too-large');
    }
    const got = this.getOrCreateList(key);
    if (got.err) return got.err;
    const v = got.v;
    for (const val of values) {
      const b = asBuffer(val);
      if (!this.engine.keyspace.containerAddMem(v, 64 + b.length)) return this.quotaErr('OOM');
      if (side === 'left') v.data.unshift(b); else v.data.push(b);
    }
    this.engine.markDirty();
    return v.data.length;
  },

  LPUSHX(key, ...values) {
    return this._pushX(normKey(key), values, 'left');
  },

  RPUSHX(key, ...values) {
    return this._pushX(normKey(key), values, 'right');
  },

  _pushX(key, values, side) {
    const v = this.liveValue(key);
    if (!v) return 0;
    if (v.kind !== 'list') return this.wrongType();
    return this._push(key, values, side);
  },

  LPOP(key, countArg) { return this._popList(normKey(key), 'left', countArg); },
  RPOP(key, countArg) { return this._popList(normKey(key), 'right', countArg); },

  _popList(key, side, countArg) {
    const v = this.liveValue(key);
    if (!v) return null;
    if (v.kind !== 'list') return this.wrongType();
    let count = 1;
    let multi = false;
    if (countArg !== undefined) {
      const n = toInt(countArg);
      if (!Number.isFinite(n) || n < 0) return { error: 'ERR value is not an integer or out of range' };
      count = n;
      multi = true;
    }
    if (count === 0) return multi ? [] : null;
    const out = [];
    for (let i = 0; i < count && v.data.length > 0; i++) {
      const b = side === 'left' ? v.data.shift() : v.data.pop();
      this.engine.keyspace.containerAddMemForce(v, -(64 + b.length));
      out.push(b);
    }
    if (out.length > 0) this.engine.markDirty();
    if (v.data.length === 0) this.engine.keyspace.deleteKey(key);
    return multi ? out : (out[0] !== undefined ? out[0] : null);
  },

  LLEN(key) {
    const v = this.liveValue(normKey(key));
    if (!v) return 0;
    if (v.kind !== 'list') return this.wrongType();
    return v.data.length;
  },

  LINDEX(key, index) {
    const v = this.liveValue(normKey(key));
    if (!v) return null;
    if (v.kind !== 'list') return this.wrongType();
    const n = toInt(index);
    if (!Number.isFinite(n)) return { error: 'ERR value is not an integer or out of range' };
    const len = v.data.length;
    const i = n < 0 ? len + n : n;
    if (i < 0 || i >= len) return null;
    return v.data[i];
  },

  LSET(key, index, value) {
    const v = this.liveValue(normKey(key));
    if (!v) return { error: 'ERR no such key' };
    if (v.kind !== 'list') return this.wrongType();
    const n = toInt(index);
    if (!Number.isFinite(n)) return { error: 'ERR value is not an integer or out of range' };
    const len = v.data.length;
    const i = n < 0 ? len + n : n;
    if (i < 0 || i >= len) return { error: 'ERR index out of range' };
    const b = asBuffer(value);
    if (this.tooLarge(b.length)) return this.quotaErr('value-too-large');
    this.engine.keyspace.containerAddMemForce(v, b.length - v.data[i].length);
    v.data[i] = b;
    this.engine.markDirty();
    return 'OK';
  },

  LINSERT(key, where, pivot, value) {
    const v = this.liveValue(normKey(key));
    if (!v) return 0;
    if (v.kind !== 'list') return this.wrongType();
    const w = String(where).toUpperCase();
    if (w !== 'BEFORE' && w !== 'AFTER') return { error: 'ERR syntax error' };
    const idx = v.data.findIndex((x) => bufEq(x, asBuffer(pivot)));
    if (idx === -1) return -1;
    const b = asBuffer(value);
    if (this.tooLarge(b.length)) return this.quotaErr('value-too-large');
    if (!this.engine.keyspace.containerAddMem(v, 64 + b.length)) return this.quotaErr('OOM');
    v.data.splice(w === 'BEFORE' ? idx : idx + 1, 0, b);
    this.engine.markDirty();
    return v.data.length;
  },

  LREM(key, count, value) {
    const v = this.liveValue(normKey(key));
    if (!v) return 0;
    if (v.kind !== 'list') return this.wrongType();
    const n = toInt(count);
    if (!Number.isFinite(n)) return { error: 'ERR value is not an integer or out of range' };
    const b = asBuffer(value);
    let removed = 0;
    const eq = (x) => bufEq(x, b);
    const dropAt = (i) => {
      this.engine.keyspace.containerAddMemForce(v, -(64 + v.data[i].length));
      v.data.splice(i, 1);
      removed++;
    };
    if (n === 0) {
      for (let i = v.data.length - 1; i >= 0; i--) if (eq(v.data[i])) dropAt(i);
    } else if (n > 0) {
      for (let i = 0; i < v.data.length && removed < n;) {
        if (eq(v.data[i])) dropAt(i); else i++;
      }
    } else {
      let remaining = -n;
      for (let i = v.data.length - 1; i >= 0 && remaining > 0; i--) {
        if (eq(v.data[i])) { dropAt(i); remaining--; }
      }
    }
    if (removed > 0) this.engine.markDirty();
    if (v.data.length === 0) this.engine.keyspace.deleteKey(normKey(key));
    return removed;
  },

  LRANGE(key, start, end) {
    const v = this.liveValue(normKey(key));
    if (!v) return [];
    if (v.kind !== 'list') return this.wrongType();
    if (!isInt(start) || !isInt(end)) return { error: 'ERR value is not an integer or out of range' };
    const len = v.data.length;
    let s = toInt(start); let e = toInt(end);
    if (s < 0) s = len + s;
    if (e < 0) e = len + e;
    if (s < 0) s = 0;
    if (e >= len) e = len - 1;
    if (len === 0 || s > e || s >= len) return [];
    return v.data.slice(s, e + 1);
  },

  LTRIM(key, start, end) {
    const k = normKey(key);
    const v = this.liveValue(k);
    if (!v) return 'OK';
    if (v.kind !== 'list') return this.wrongType();
    if (!isInt(start) || !isInt(end)) return { error: 'ERR value is not an integer or out of range' };
    const len = v.data.length;
    let s = toInt(start); let e = toInt(end);
    if (s < 0) s = len + s;
    if (e < 0) e = len + e;
    if (s < 0) s = 0;
    if (e >= len) e = len - 1;
    if (len === 0 || s > e || s >= len) {
      this.engine.keyspace.deleteKey(k);
      this.engine.markDirty();
      return 'OK';
    }
    const removed = v.data.slice(0, s).concat(v.data.slice(e + 1));
    let memDelta = 0;
    for (const b of removed) memDelta -= 64 + b.length;
    this.engine.keyspace.containerAddMemForce(v, memDelta);
    v.data = v.data.slice(s, e + 1);
    this.engine.markDirty();
    return 'OK';
  },

  RPOPLPUSH(src, dst) {
    return this.LMOVE(normKey(src), normKey(dst), 'RIGHT', 'LEFT');
  },

  LMOVE(src, dst, from, to) {
    const sk = normKey(src);
    const dk = normKey(dst);
    const f = String(from).toUpperCase();
    const t = String(to).toUpperCase();
    if ((f !== 'LEFT' && f !== 'RIGHT') || (t !== 'LEFT' && t !== 'RIGHT')) {
      return { error: 'ERR syntax error' };
    }
    const popped = f === 'LEFT' ? this.LPOP(sk) : this.RPOP(sk);
    if (popped === null) return null;
    if (popped && typeof popped === 'object' && popped.error) return popped;
    const r = t === 'LEFT' ? this.LPUSH(dk, popped) : this.RPUSH(dk, popped);
    if (r && typeof r === 'object' && r.error) return r;
    return popped;
  },

  // ───────────────────────── sets ─────────────────────────
  SADD(key, ...members) {
    if (members.length === 0) return this.wrongArg('sadd');
    const k = normKey(key);
    let v = this.liveValue(k);
    if (v && v.kind !== 'set') return this.wrongType();
    if (!v) {
      const c = this.engine.keyspace.createContainer(k, 'set', new Set());
      if (!c.ok) return this.quotaErr(c.error);
      v = c.value;
    }
    let added = 0;
    for (const m of members) {
      const s = m.toString('utf8');
      if (v.data.has(s)) continue;
      if (this.tooLarge(s.length)) return this.quotaErr('value-too-large');
      if (!this.engine.keyspace.containerAddMem(v, 80 + s.length)) return this.quotaErr('OOM');
      v.data.add(s);
      added++;
    }
    if (added > 0) this.engine.markDirty();
    return added;
  },

  SREM(key, ...members) {
    const k = normKey(key);
    const v = this.liveValue(k);
    if (!v) return 0;
    if (v.kind !== 'set') return this.wrongType();
    let removed = 0;
    for (const m of members) {
      const s = m.toString('utf8');
      if (v.data.delete(s)) {
        this.engine.keyspace.containerAddMemForce(v, -(80 + s.length));
        removed++;
      }
    }
    if (removed > 0) this.engine.markDirty();
    if (v.data.size === 0) this.engine.keyspace.deleteKey(k);
    return removed;
  },

  SISMEMBER(key, member) {
    const v = this.liveValue(normKey(key));
    if (!v) return 0;
    if (v.kind !== 'set') return this.wrongType();
    return v.data.has(member.toString('utf8')) ? 1 : 0;
  },

  SMISMEMBER(key, ...members) {
    const v = this.liveValue(normKey(key));
    if (!v) return members.map(() => 0);
    if (v.kind !== 'set') return this.wrongType();
    return members.map((m) => (v.data.has(m.toString('utf8')) ? 1 : 0));
  },

  SCARD(key) {
    const v = this.liveValue(normKey(key));
    if (!v) return 0;
    if (v.kind !== 'set') return this.wrongType();
    return v.data.size;
  },

  SMEMBERS(key) {
    const v = this.liveValue(normKey(key));
    if (!v) return [];
    if (v.kind !== 'set') return this.wrongType();
    return Array.from(v.data).map((s) => Buffer.from(s, 'utf8'));
  },

  SPOP(key, countArg) {
    const k = normKey(key);
    const v = this.liveValue(k);
    if (!v) return countArg !== undefined ? [] : null;
    if (v.kind !== 'set') return this.wrongType();
    let count = 1;
    let multi = false;
    if (countArg !== undefined) {
      const n = toInt(countArg);
      if (!Number.isFinite(n) || n < 0) return { error: 'ERR value is not an integer or out of range' };
      count = n;
      multi = true;
    }
    const out = [];
    for (let i = 0; i < count && v.data.size > 0; i++) {
      const arr = Array.from(v.data);
      const s = arr[Math.floor(this.engine.rng() * arr.length)];
      v.data.delete(s);
      this.engine.keyspace.containerAddMemForce(v, -(80 + s.length));
      out.push(Buffer.from(s, 'utf8'));
    }
    if (out.length > 0) this.engine.markDirty();
    if (v.data.size === 0) this.engine.keyspace.deleteKey(k);
    return multi ? out : (out[0] !== undefined ? out[0] : null);
  },

  SRANDMEMBER(key, countArg) {
    const v = this.liveValue(normKey(key));
    if (!v) return countArg !== undefined ? [] : null;
    if (v.kind !== 'set') return this.wrongType();
    const members = Array.from(v.data);
    if (countArg === undefined) {
      return members.length === 0
        ? null
        : Buffer.from(members[Math.floor(this.engine.rng() * members.length)], 'utf8');
    }
    const n = toInt(countArg);
    if (!Number.isFinite(n)) return { error: 'ERR value is not an integer or out of range' };
    if (n >= 0) {
      const out = [];
      const used = new Set();
      const take = Math.min(n, members.length);
      while (out.length < take && used.size < members.length) {
        const idx = Math.floor(this.engine.rng() * members.length);
        if (used.has(idx)) continue;
        used.add(idx);
        out.push(Buffer.from(members[idx], 'utf8'));
      }
      return out;
    }
    const out = [];
    for (let i = 0; i < -n && members.length > 0; i++) {
      out.push(Buffer.from(members[Math.floor(this.engine.rng() * members.length)], 'utf8'));
    }
    return out;
  },

  _collectSets(keys) {
    const sets = [];
    for (const k of keys) {
      const v = this.liveValue(normKey(k));
      if (v && v.kind !== 'set') return { err: this.wrongType() };
      sets.push(v ? v.data : null);
    }
    return { sets };
  },

  _storeSetResult(dst, members) {
    const dk = normKey(dst);
    this.engine.keyspace.deleteKey(dk);
    if (members.size === 0) { this.engine.markDirty(); return 0; }
    const c = this.engine.keyspace.createContainer(dk, 'set', new Set(members));
    if (!c.ok) return this.quotaErr(c.error);
    let mem = 0;
    for (const s of members) mem += 80 + s.length;
    this.engine.keyspace.containerAddMemForce(c.value, mem);
    this.engine.markDirty();
    return c.value.data.size;
  },

  SUNION(...keys) {
    const r = this._collectSets(keys);
    if (r.err) return r.err;
    const out = new Set();
    for (const s of r.sets) if (s) for (const m of s) out.add(m);
    return Array.from(out).map((s) => Buffer.from(s, 'utf8'));
  },

  SUNIONSTORE(dst, ...keys) {
    const r = this._collectSets(keys);
    if (r.err) return r.err;
    const out = new Set();
    for (const s of r.sets) if (s) for (const m of s) out.add(m);
    return this._storeSetResult(dst, out);
  },

  SINTER(...keys) {
    const r = this._collectSets(keys);
    if (r.err) return r.err;
    if (r.sets.some((s) => s === null || s.size === 0)) return [];
    let acc = null;
    for (const s of r.sets) {
      if (acc === null) acc = new Set(s);
      else acc = new Set(Array.from(acc).filter((m) => s.has(m)));
    }
    return Array.from(acc || new Set()).map((s) => Buffer.from(s, 'utf8'));
  },

  SINTERSTORE(dst, ...keys) {
    const r = this.SINTER(...keys);
    if (r && typeof r === 'object' && r.error) return r;
    return this._storeSetResult(dst, new Set(r.map((b) => b.toString('utf8'))));
  },

  SDIFF(...keys) {
    const r = this._collectSets(keys);
    if (r.err) return r.err;
    const first = r.sets[0];
    if (!first) return [];
    const out = new Set(first);
    for (let i = 1; i < r.sets.length; i++) {
      const s = r.sets[i];
      if (s) for (const m of s) out.delete(m);
    }
    return Array.from(out).map((s) => Buffer.from(s, 'utf8'));
  },

  SDIFFSTORE(dst, ...keys) {
    const r = this.SDIFF(...keys);
    if (r && typeof r === 'object' && r.error) return r;
    return this._storeSetResult(dst, new Set(r.map((b) => b.toString('utf8'))));
  },

  // ───────────────────────── sorted sets ─────────────────────────
  _zsetAdd(v, member, score) {
    const existing = v.data.map.get(member);
    if (existing !== undefined) {
      if (existing === score) return 0;
      sortedRemove(v.data.sorted, member);
      v.data.map.set(member, score);
      sortedUpsert(v.data.sorted, member, score);
      return 1; // updated
    }
    v.data.map.set(member, score);
    sortedUpsert(v.data.sorted, member, score);
    return 2; // added
  },

  _zsetMemberScore(v, member) {
    return v.data.map.get(member);
  },

  _ensureZset(key) {
    let v = this.liveValue(key);
    if (v && v.kind !== 'zset') return { err: this.wrongType() };
    if (!v) {
      const c = this.engine.keyspace.createContainer(key, 'zset', { map: new Map(), sorted: [] });
      if (!c.ok) return { err: this.quotaErr(c.error) };
      v = c.value;
    }
    return { v };
  },

  ZADD(key, ...args) {
    if (args.length < 2) return this.wrongArg('zadd');
    const k = normKey(key);
    let idx = 0;
    let nx = false; let xx = false; let gt = false; let lt = false; let ch = false; let incr = false;
    for (; idx < args.length; idx++) {
      const f = String(args[idx]).toUpperCase();
      if (f === 'NX') nx = true;
      else if (f === 'XX') xx = true;
      else if (f === 'GT') gt = true;
      else if (f === 'LT') lt = true;
      else if (f === 'CH') ch = true;
      else if (f === 'INCR') incr = true;
      else break;
    }
    const rest = args.slice(idx);
    if (rest.length === 0 || rest.length % 2 !== 0) return this.wrongArg('zadd');
    if ([nx, xx, gt, lt].filter(Boolean).length > 1) {
      return { error: 'ERR GT, LT, and/or NX options at the same time are not compatible' };
    }

    const got = this._ensureZset(k);
    if (got.err) return got.err;
    const z = got.v;

    const pairs = [];
    for (let i = 0; i < rest.length; i += 2) {
      const score = parseScore(rest[i]);
      if (Number.isNaN(score)) return { error: 'ERR value is not a valid float' };
      pairs.push([rest[i + 1].toString('utf8'), score]);
    }

    if (incr) {
      if (pairs.length !== 1) return { error: 'ERR INCR option supports a single increment-operation pair' };
      const [member, delta] = pairs[0];
      const cur = this._zsetMemberScore(z, member);
      if (cur === undefined && xx) return null;
      if (cur !== undefined && nx) return null;
      const next = (cur === undefined ? 0 : cur) + delta;
      if (!Number.isFinite(next)) return { error: 'ERR resulting score is not a number (NaN)' };
      this._zsetAdd(z, member, next);
      this.engine.markDirty();
      return formatScore(next);
    }

    let added = 0; let updated = 0;
    for (const [member, score] of pairs) {
      const cur = this._zsetMemberScore(z, member);
      if (cur !== undefined) {
        if (nx) continue;
        if (gt && score <= cur) continue;
        if (lt && score >= cur) continue;
        if (cur === score) continue;
        this._zsetAdd(z, member, score);
        updated++;
      } else {
        if (xx) continue;
        this._zsetAdd(z, member, score);
        added++;
      }
    }
    if (added + updated > 0) this.engine.markDirty();
    return ch ? added + updated : added;
  },

  ZSCORE(key, member) {
    const v = this.liveValue(normKey(key));
    if (!v) return null;
    if (v.kind !== 'zset') return this.wrongType();
    const s = this._zsetMemberScore(v, member.toString('utf8'));
    return s === undefined ? null : Buffer.from(formatScore(s), 'utf8');
  },

  ZMSCORE(key, ...members) {
    const v = this.liveValue(normKey(key));
    if (!v) return members.map(() => null);
    if (v.kind !== 'zset') return this.wrongType();
    return members.map((m) => {
      const s = this._zsetMemberScore(v, m.toString('utf8'));
      return s === undefined ? null : Buffer.from(formatScore(s), 'utf8');
    });
  },

  ZINCRBY(key, by, member) {
    const delta = parseScore(by);
    if (Number.isNaN(delta)) return { error: 'ERR value is not a valid float' };
    const got = this._ensureZset(normKey(key));
    if (got.err) return got.err;
    const m = member.toString('utf8');
    const cur = this._zsetMemberScore(got.v, m);
    const next = (cur === undefined ? 0 : cur) + delta;
    if (!Number.isFinite(next)) return { error: 'ERR resulting score is not a number (NaN)' };
    this._zsetAdd(got.v, m, next);
    this.engine.markDirty();
    return Buffer.from(formatScore(next), 'utf8');
  },

  ZCARD(key) {
    const v = this.liveValue(normKey(key));
    if (!v) return 0;
    if (v.kind !== 'zset') return this.wrongType();
    return v.data.map.size;
  },

  ZCOUNT(key, min, max) {
    const v = this.liveValue(normKey(key));
    if (!v) return 0;
    if (v.kind !== 'zset') return this.wrongType();
    const lo = parseBound(min); const hi = parseBound(max);
    if (!lo || !hi) return { error: 'ERR min or max is not a float' };
    let n = 0;
    for (const [, score] of v.data.sorted) {
      if (score > lo.v && score < hi.v) n++;
      else if (!lo.excl && score === lo.v) n++;
      else if (!hi.excl && score === hi.v) n++;
    }
    return n;
  },

  _zrangeReply(key, startStr, stopStr, rev, withScores, opts = {}) {
    const v = this.liveValue(normKey(key));
    if (!v) return [];
    if (v.kind !== 'zset') return this.wrongType();
    let items = v.data.sorted;
    if (rev) items = items.slice().reverse();
    if (opts.byScore) {
      const lo = parseBound(startStr); const hi = parseBound(stopStr);
      if (!lo || !hi) return { error: 'ERR min or max is not a float' };
      items = items.filter(([m, sc]) => {
        if (lo.excl ? sc <= lo.v : sc < lo.v) return false;
        if (hi.excl ? sc >= hi.v : sc > hi.v) return false;
        return true;
      });
      if (opts.limit !== undefined) {
        const [off, cnt] = opts.limit;
        items = cnt === -1 ? items.slice(off) : items.slice(off, off + cnt);
      }
    } else if (opts.byLex) {
      const lo = opts.lexMin; const hi = opts.lexMax;
      items = items.filter(([m]) => {
        if (lo && !lo.match(m)) return false;
        if (hi && !hi.match(m)) return false;
        return true;
      });
      if (opts.limit !== undefined) {
        const [off, cnt] = opts.limit;
        items = cnt === -1 ? items.slice(off) : items.slice(off, off + cnt);
      }
    } else {
      let start = toInt(startStr); let stop = toInt(stopStr);
      if (!Number.isFinite(start) || !Number.isFinite(stop)) {
        return { error: 'ERR value is not an integer or out of range' };
      }
      const len = items.length;
      let s = start < 0 ? len + start : start;
      let e = stop < 0 ? len + stop : stop;
      if (s < 0) s = 0;
      if (e >= len) e = len - 1;
      if (len === 0 || s > e || s >= len) return [];
      items = items.slice(s, e + 1);
    }
    const out = [];
    for (const [m, sc] of items) {
      out.push(Buffer.from(m, 'utf8'));
      if (withScores) out.push(Buffer.from(formatScore(sc), 'utf8'));
    }
    return out;
  },

  _parseLexBound(s, isUpper = false) {
    const str = String(s);
    if (str === '-' || str === '+') return { match: () => true };
    if (str.startsWith('[')) {
      const p = str.slice(1);
      return { match: (m) => isUpper
        ? comparePairs([m, 0], [p, 0]) <= 0
        : comparePairs([m, 0], [p, 0]) >= 0 };
    }
    if (str.startsWith('(')) {
      const p = str.slice(1);
      return { match: (m) => isUpper
        ? comparePairs([m, 0], [p, 0]) < 0
        : comparePairs([m, 0], [p, 0]) > 0 };
    }
    return null;
  },

  ZRANGE(key, start, stop, ...rest) {
    let rev = false; let withScores = false; let byScore = false; let byLex = false;
    let limit;
    for (let i = 0; i < rest.length; i++) {
      const f = String(rest[i]).toUpperCase();
      if (f === 'REV') rev = true;
      else if (f === 'WITHSCORES') withScores = true;
      else if (f === 'BYSCORE') byScore = true;
      else if (f === 'BYLEX') byLex = true;
      else if (f === 'LIMIT') {
        const off = toInt(rest[++i]); const cnt = toInt(rest[++i]);
        if (!Number.isFinite(off) || !Number.isFinite(cnt)) return { error: 'ERR value is not an integer or out of range' };
        limit = [off, cnt];
      }
    }
    return this._zrangeReply(key, start, stop, rev, withScores, { byScore, byLex, limit });
  },

  ZRANGEBYSCORE(key, min, max, ...rest) {
    let withScores = false; let limit;
    for (let i = 0; i < rest.length; i++) {
      const f = String(rest[i]).toUpperCase();
      if (f === 'WITHSCORES') withScores = true;
      else if (f === 'LIMIT') {
        const off = toInt(rest[++i]); const cnt = toInt(rest[++i]);
        limit = [off, cnt];
      }
    }
    return this._zrangeReply(key, min, max, false, withScores, { byScore: true, limit });
  },

  ZREVRANGEBYSCORE(key, max, min, ...rest) {
    let withScores = false; let limit;
    for (let i = 0; i < rest.length; i++) {
      const f = String(rest[i]).toUpperCase();
      if (f === 'WITHSCORES') withScores = true;
      else if (f === 'LIMIT') {
        const off = toInt(rest[++i]); const cnt = toInt(rest[++i]);
        limit = [off, cnt];
      }
    }
    return this._zrangeReply(key, min, max, true, withScores, { byScore: true, limit });
  },

  ZREVRANGE(key, start, stop, ...rest) {
    const withScores = rest.some((r) => String(r).toUpperCase() === 'WITHSCORES');
    return this._zrangeReply(key, start, stop, true, withScores, {});
  },

  ZRANGEBYLEX(key, min, max, ...rest) {
    let limit;
    for (let i = 0; i < rest.length; i++) {
      if (String(rest[i]).toUpperCase() === 'LIMIT') {
        limit = [toInt(rest[++i]), toInt(rest[++i])];
      }
    }
    const lo = this._parseLexBound(min, false);
    const hi = this._parseLexBound(max, true);
    if (!lo || !hi) return { error: 'ERR min or max not valid string range item' };
    return this._zrangeReply(key, 0, -1, false, false, { byLex: true, lexMin: lo, lexMax: hi, limit });
  },

  ZREVRANGEBYLEX(key, max, min, ...rest) {
    let limit;
    for (let i = 0; i < rest.length; i++) {
      if (String(rest[i]).toUpperCase() === 'LIMIT') {
        limit = [toInt(rest[++i]), toInt(rest[++i])];
      }
    }
    const lo = this._parseLexBound(min, false);
    const hi = this._parseLexBound(max, true);
    if (!lo || !hi) return { error: 'ERR min or max not valid string range item' };
    return this._zrangeReply(key, 0, -1, true, false, { byLex: true, lexMin: lo, lexMax: hi, limit });
  },

  ZRANK(key, member) {
    const v = this.liveValue(normKey(key));
    if (!v) return null;
    if (v.kind !== 'zset') return this.wrongType();
    const m = member.toString('utf8');
    const idx = v.data.sorted.findIndex((p) => p[0] === m);
    return idx === -1 ? null : idx;
  },

  ZREVRANK(key, member) {
    const v = this.liveValue(normKey(key));
    if (!v) return null;
    if (v.kind !== 'zset') return this.wrongType();
    const m = member.toString('utf8');
    const idx = v.data.sorted.findIndex((p) => p[0] === m);
    return idx === -1 ? null : v.data.sorted.length - 1 - idx;
  },

  ZREM(key, ...members) {
    const k = normKey(key);
    const v = this.liveValue(k);
    if (!v) return 0;
    if (v.kind !== 'zset') return this.wrongType();
    let removed = 0;
    for (const m of members) {
      const s = m.toString('utf8');
      if (v.data.map.delete(s)) {
        sortedRemove(v.data.sorted, s);
        removed++;
      }
    }
    if (removed > 0) this.engine.markDirty();
    if (v.data.map.size === 0) this.engine.keyspace.deleteKey(k);
    return removed;
  },

  ZPOPMIN(key, countArg) { return this._zpop(normKey(key), false, countArg); },
  ZPOPMAX(key, countArg) { return this._zpop(normKey(key), true, countArg); },

  _zpop(key, max, countArg) {
    const v = this.liveValue(key);
    if (!v) return countArg !== undefined ? [] : null;
    if (v.kind !== 'zset') return this.wrongType();
    let count = 1;
    const multi = countArg !== undefined;
    if (multi) {
      const n = toInt(countArg);
      if (!Number.isFinite(n) || n < 0) return { error: 'ERR value is not an integer or out of range' };
      count = n;
    }
    const out = [];
    for (let i = 0; i < count && v.data.sorted.length > 0; i++) {
      const pair = max ? v.data.sorted[v.data.sorted.length - 1] : v.data.sorted[0];
      this.ZREM(key, Buffer.from(pair[0], 'utf8'));
      out.push(Buffer.from(pair[0], 'utf8'), Buffer.from(formatScore(pair[1]), 'utf8'));
    }
    if (out.length > 0) this.engine.markDirty();
    if (v.data.map.size === 0) this.engine.keyspace.deleteKey(key);
    if (!multi) return out.length ? out : null;
    return out;
  },

  _zsetUnionInter(keys, op, weights, aggregate) {
    const collected = [];
    for (const k of keys) {
      const v = this.liveValue(normKey(k));
      if (v && v.kind !== 'zset') return { err: this.wrongType() };
      collected.push(v ? v.data.map : null);
    }
    const result = new Map();
    if (op === 'union') {
      for (let i = 0; i < collected.length; i++) {
        const w = weights[i];
        const src = collected[i];
        if (!src) continue;
        for (const [m, s] of src) {
          const val = s * w;
          if (result.has(m)) result.set(m, this._agg(result.get(m), val, aggregate));
          else result.set(m, val);
        }
      }
    } else {
      const first = collected[0];
      if (!first) return result;
      for (const [m, s] of first) {
        let ok = true;
        let acc = s * weights[0];
        for (let i = 1; i < collected.length; i++) {
          const other = collected[i];
          if (!other || !other.has(m)) { ok = false; break; }
          acc = this._agg(acc, other.get(m) * weights[i], aggregate);
        }
        if (ok) result.set(m, acc);
      }
    }
    return result;
  },

  _agg(a, b, mode) {
    if (mode === 'MAX') return Math.max(a, b);
    if (mode === 'MIN') return Math.min(a, b);
    return a + b;
  },

  _parseWeightAgg(args) {
    let weights = null;
    let aggregate = 'SUM';
    for (let i = 0; i < args.length; i++) {
      const f = String(args[i]).toUpperCase();
      if (f === 'WEIGHTS') {
        weights = [];
        i++;
        while (i < args.length && !Number.isNaN(Number(args[i]))) {
          weights.push(Number(args[i]));
          i++;
        }
        i--;
        if (weights.length === 0) return { err: { error: 'ERR weight is not a double' } };
      } else if (f === 'AGGREGATE') {
        const mode = String(args[++i] || '').toUpperCase();
        if (!['SUM', 'MIN', 'MAX'].includes(mode)) return { err: { error: 'ERR syntax error' } };
        aggregate = mode;
      }
    }
    return { weights, aggregate };
  },

  ZUNIONSTORE(dst, numkeys, ...rest) {
    return this._zstore(dst, 'union', numkeys, rest);
  },

  ZINTERSTORE(dst, numkeys, ...rest) {
    return this._zstore(dst, 'inter', numkeys, rest);
  },

  _zstore(dst, op, numkeys, rest) {
    const n = toInt(numkeys);
    if (!Number.isFinite(n) || n < 1) return { error: 'ERR numkeys should be greater than 0' };
    const keys = rest.slice(0, n);
    const opts = rest.slice(n);
    const parsed = this._parseWeightAgg(opts);
    if (parsed.err) return parsed.err;
    const weights = parsed.weights || keys.map(() => 1);
    if (weights.length !== keys.length) return { error: 'ERR syntax error' };
    const result = this._zsetUnionInter(keys, op, weights, parsed.aggregate);
    if (result && result.err) return result.err;
    const dk = normKey(dst);
    this.engine.keyspace.deleteKey(dk);
    if (result.size === 0) { this.engine.markDirty(); return 0; }
    const c = this.engine.keyspace.createContainer(dk, 'zset', { map: new Map(), sorted: [] });
    if (!c.ok) return this.quotaErr(c.error);
    for (const [m, s] of result) this._zsetAdd(c.value, m, s);
    let mem = 0;
    for (const [m] of result) mem += 48 + m.length;
    this.engine.keyspace.containerAddMemForce(c.value, mem);
    this.engine.markDirty();
    return c.value.data.map.size;
  },

  // ───────────────────────── hashes ─────────────────────────
  HSET(key, ...args) {
    if (args.length === 0 || args.length % 2 !== 0) return this.wrongArg('hset');
    const k = normKey(key);
    let v = this.liveValue(k);
    if (v && v.kind !== 'hash') return this.wrongType();
    if (!v) {
      const c = this.engine.keyspace.createContainer(k, 'hash', new Map());
      if (!c.ok) return this.quotaErr(c.error);
      v = c.value;
    }
    let added = 0;
    for (let i = 0; i < args.length; i += 2) {
      const f = args[i].toString('utf8');
      const val = asBuffer(args[i + 1]);
      if (this.tooLarge(val.length)) return this.quotaErr('value-too-large');
      const isNew = !v.data.has(f);
      const old = v.data.get(f);
      if (isNew) {
        if (!this.engine.keyspace.containerAddMem(v, 64 + f.length + val.length)) return this.quotaErr('OOM');
        added++;
      } else if (!bufEq(old, val)) {
        this.engine.keyspace.containerAddMemForce(v, val.length - old.length);
      }
      v.data.set(f, val);
    }
    if (added > 0 || args.length > 0) this.engine.markDirty();
    return added;
  },

  HMGET(key, ...fields) {
    const v = this.liveValue(normKey(key));
    if (!v) return fields.map(() => null);
    if (v.kind !== 'hash') return this.wrongType();
    return fields.map((f) => {
      const val = v.data.get(f.toString('utf8'));
      return val === undefined ? null : val;
    });
  },

  HGET(key, field) {
    const v = this.liveValue(normKey(key));
    if (!v) return null;
    if (v.kind !== 'hash') return this.wrongType();
    const val = v.data.get(field.toString('utf8'));
    return val === undefined ? null : val;
  },

  HGETALL(key) {
    const v = this.liveValue(normKey(key));
    if (!v) return [];
    if (v.kind !== 'hash') return this.wrongType();
    const out = [];
    for (const [f, val] of v.data) out.push(Buffer.from(f, 'utf8'), val);
    return out;
  },

  HDEL(key, ...fields) {
    const k = normKey(key);
    const v = this.liveValue(k);
    if (!v) return 0;
    if (v.kind !== 'hash') return this.wrongType();
    let removed = 0;
    for (const f of fields) {
      const s = f.toString('utf8');
      const val = v.data.get(s);
      if (val !== undefined) {
        v.data.delete(s);
        this.engine.keyspace.containerAddMemForce(v, -(64 + s.length + val.length));
        removed++;
      }
    }
    if (removed > 0) this.engine.markDirty();
    if (v.data.size === 0) this.engine.keyspace.deleteKey(k);
    return removed;
  },

  HEXISTS(key, field) {
    const v = this.liveValue(normKey(key));
    if (!v) return 0;
    if (v.kind !== 'hash') return this.wrongType();
    return v.data.has(field.toString('utf8')) ? 1 : 0;
  },

  HKEYS(key) {
    const v = this.liveValue(normKey(key));
    if (!v) return [];
    if (v.kind !== 'hash') return this.wrongType();
    return Array.from(v.data.keys()).map((f) => Buffer.from(f, 'utf8'));
  },

  HVALS(key) {
    const v = this.liveValue(normKey(key));
    if (!v) return [];
    if (v.kind !== 'hash') return this.wrongType();
    return Array.from(v.data.values());
  },

  HLEN(key) {
    const v = this.liveValue(normKey(key));
    if (!v) return 0;
    if (v.kind !== 'hash') return this.wrongType();
    return v.data.size;
  },

  HSTRLEN(key, field) {
    const v = this.liveValue(normKey(key));
    if (!v) return 0;
    if (v.kind !== 'hash') return this.wrongType();
    const val = v.data.get(field.toString('utf8'));
    return val === undefined ? 0 : val.length;
  },

  HSETNX(key, field, value) {
    const k = normKey(key);
    const v = this.liveValue(k);
    if (v && v.kind !== 'hash') return this.wrongType();
    if (v && v.data.has(field.toString('utf8'))) return 0;
    const r = this.HSET(k, field, value);
    if (r && typeof r === 'object' && r.error) return r;
    return 1;
  },

  HINCRBY(key, field, by) {
    const n = toInt(by);
    if (!Number.isFinite(n)) return { error: 'ERR value is not an integer or out of range' };
    return this._hIncr(normKey(key), field, n, false);
  },

  HINCRBYFLOAT(key, field, by) {
    const f = Number(by);
    if (!Number.isFinite(f)) return { error: 'ERR value is not a valid float' };
    return this._hIncr(normKey(key), field, f, true);
  },

  _hIncr(key, field, delta, isFloatMode) {
    let v = this.liveValue(key);
    if (v && v.kind !== 'hash') return this.wrongType();
    if (!v) {
      const c = this.engine.keyspace.createContainer(key, 'hash', new Map());
      if (!c.ok) return this.quotaErr(c.error);
      v = c.value;
    }
    const f = field.toString('utf8');
    const curStr = v.data.has(f) ? v.data.get(f).toString('utf8') : '0';
    if (!isFloatMode && !/^-?\d+$/.test(curStr.trim())) return { error: 'ERR hash value is not an integer' };
    const cur = Number(curStr);
    if (Number.isNaN(cur)) return { error: 'ERR hash value is not a number' };
    const next = cur + delta;
    if (!isFloatMode && !Number.isSafeInteger(next)) return { error: 'ERR increment or decrement would overflow' };
    const out = isFloatMode ? String(parseFloat(next.toFixed(17))) : String(next);
    const isNew = !v.data.has(f);
    const old = v.data.get(f);
    if (isNew) {
      if (!this.engine.keyspace.containerAddMem(v, 64 + f.length + out.length)) return this.quotaErr('OOM');
    } else {
      this.engine.keyspace.containerAddMemForce(v, out.length - old.length);
    }
    v.data.set(f, Buffer.from(out, 'utf8'));
    this.engine.markDirty();
    return Buffer.from(out, 'utf8');
  },
};

module.exports = { Collections };
