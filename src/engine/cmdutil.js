'use strict';

const { comparePairs } = require('./zsetutil');

const INT_RE = /^-?\d+$/;

function asStr(s) {
  return Buffer.isBuffer(s) ? s.toString('utf8') : String(s);
}

function isInt(s) {
  const str = asStr(s);
  return INT_RE.test(str) && str.length < 19;
}

function toInt(s) {
  return Number.parseInt(asStr(s), 10);
}

function isFloat(s) {
  const str = asStr(s);
  if (str === '') return false;
  const n = Number(str);
  return Number.isFinite(n) && /^[-+]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(str);
}

function toFloat(s) {
  return Number(asStr(s));
}

function bufEq(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return Buffer.compare(a, b) === 0;
}

/** Parse a zset score: supports inf/-inf. Returns NaN when invalid. */
function parseScore(s) {
  const str = asStr(s).trim().toLowerCase();
  if (str === 'inf' || str === '+inf' || str === 'infinity' || str === '+infinity') return Infinity;
  if (str === '-inf' || str === '-infinity') return -Infinity;
  if (!/[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/.test(str)) return NaN;
  const n = Number(str);
  return Number.isFinite(n) ? n : NaN;
}

/** Parse a BYSCORE range bound: '(' prefix = exclusive, inf allowed. */
function parseBound(s) {
  const str = asStr(s);
  let excl = false;
  let val = str;
  if (str.startsWith('(')) {
    excl = true;
    val = str.slice(1);
  }
  const v = parseScore(val);
  if (Number.isNaN(v)) return null;
  return { v, excl };
}

function formatScore(n) {
  if (n === Infinity) return 'inf';
  if (n === -Infinity) return '-inf';
  if (Number.isInteger(n)) return String(n);
  return String(n);
}

/** Redis glob-style pattern to RegExp. */
function globToRegex(pattern) {
  const out = [];
  const plain = (ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\') {
      i++;
      if (i < pattern.length) out.push(plain(pattern[i]));
    } else if (ch === '*') out.push('.*');
    else if (ch === '?') out.push('.');
    else if (ch === '[') {
      let j = i + 1;
      let neg = false;
      if (pattern[j] === '^') { neg = true; j++; }
      let cls = '';
      while (j < pattern.length && pattern[j] !== ']') { cls += pattern[j]; j++; }
      if (j >= pattern.length) { out.push('\\['); continue; }
      out.push('[' + (neg ? '^' : '') + cls.replace(/\\/g, '\\\\') + ']');
      i = j;
    } else out.push(plain(ch));
  }
  return new RegExp('^' + out.join('') + '$');
}

/** Keep the sorted array view of a zset in sync (insert position via binary search). */
function sortedUpsert(sorted, member, score) {
  let lo = 0;
  let hi = sorted.length;
  const pair = [member, score];
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (comparePairs(sorted[mid], pair) < 0) lo = mid + 1;
    else hi = mid;
  }
  sorted.splice(lo, 0, pair);
}

function sortedRemove(sorted, member) {
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i][0] === member) {
      sorted.splice(i, 1);
      return true;
    }
  }
  return false;
}

/**
 * Normalize a key argument (Buffer or string) to a string Map key.
 * latin1 is a byte-bijective encoding, so distinct binary keys stay distinct.
 */
function normKey(k) {
  if (Buffer.isBuffer(k)) return k.toString('latin1');
  return String(k);
}

module.exports = {
  isInt, toInt, isFloat, toFloat, bufEq, normKey,
  parseScore, parseBound, formatScore,
  globToRegex, sortedUpsert, sortedRemove, comparePairs,
};
