'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Engine } = require('../backend/engine/engine');

function makeEngine(limits = {}) {
  return new Engine({
    name: 'test',
    limits: { maxKeys: 1000, maxMemoryBytes: 0, maxValueBytes: 1024, ...limits },
    nowFn: () => now,
  });
}

let now = 1_000_000;

function exec(e, ...args) {
  return e.execute(args.map((a) => Buffer.from(String(a), 'utf8')));
}

test('strings: set/get roundtrip', () => {
  const e = makeEngine();
  assert.strictEqual(exec(e, 'SET', 'k', 'v'), 'OK');
  const g = exec(e, 'GET', 'k');
  assert.strictEqual(g.toString(), 'v');
  assert.strictEqual(exec(e, 'GET', 'missing'), null);
});

test('strings: incr/decr and counters', () => {
  const e = makeEngine();
  assert.strictEqual(exec(e, 'INCR', 'n'), 1);
  assert.strictEqual(exec(e, 'INCR', 'n'), 2);
  assert.strictEqual(exec(e, 'INCRBY', 'n', '10'), 12);
  assert.strictEqual(exec(e, 'DECR', 'n'), 11);
  assert.strictEqual(exec(e, 'DECRBY', 'n', '11'), 0);
  exec(e, 'SET', 's', 'abc');
  const err = exec(e, 'INCR', 's');
  assert.ok(err.error && err.error.includes('not an integer'));
});

test('strings: append, strlen, getrange, setrange', () => {
  const e = makeEngine();
  exec(e, 'SET', 'k', 'hello');
  assert.strictEqual(exec(e, 'APPEND', 'k', ' world'), 11);
  assert.strictEqual(exec(e, 'GET', 'k').toString(), 'hello world');
  assert.strictEqual(exec(e, 'STRLEN', 'k'), 11);
  assert.strictEqual(exec(e, 'GETRANGE', 'k', '0', '4').toString(), 'hello');
  assert.strictEqual(exec(e, 'SETRANGE', 'k', '6', 'WORLD'), 11);
  assert.strictEqual(exec(e, 'GET', 'k').toString(), 'hello WORLD');
  assert.strictEqual(exec(e, 'SETRANGE', 'pad', '4', 'x'), 5);
  assert.strictEqual(exec(e, 'GET', 'pad').toString(), '\x00\x00\x00\x00x');
});

test('strings: mget/mset/msetnx/getset/setnx', () => {
  const e = makeEngine();
  assert.strictEqual(exec(e, 'MSET', 'a', '1', 'b', '2'), 'OK');
  const m = exec(e, 'MGET', 'a', 'b', 'c');
  assert.deepStrictEqual(m.map((x) => (x ? x.toString() : null)), ['1', '2', null]);
  assert.strictEqual(exec(e, 'MSETNX', 'c', '3', 'a', '9'), 0);
  assert.strictEqual(exec(e, 'GET', 'a').toString(), '1');
  assert.strictEqual(exec(e, 'MSETNX', 'c', '3', 'd', '4'), 1);
  assert.strictEqual(exec(e, 'SETNX', 'a', 'x'), 0);
  assert.strictEqual(exec(e, 'SETNX', 'e', 'x'), 1);
  assert.strictEqual(exec(e, 'GETSET', 'e', 'y').toString(), 'x');
});

test('expiry: set ex / ttl / persist / lazy + active expiry', () => {
  const e = makeEngine();
  exec(e, 'SET', 'k', 'v', 'EX', '10');
  assert.strictEqual(exec(e, 'TTL', 'k'), 10);
  assert.strictEqual(exec(e, 'PERSIST', 'k'), 1);
  assert.strictEqual(exec(e, 'TTL', 'k'), -1);
  exec(e, 'PEXPIRE', 'k', '50');
  assert.strictEqual(exec(e, 'PTTL', 'k') > 0, true);
  now += 100;
  assert.strictEqual(exec(e, 'GET', 'k'), null);
  assert.strictEqual(exec(e, 'TTL', 'k'), -2);
  exec(e, 'SET', 'k2', 'v2', 'PX', '50');
  now += 100;
  assert.strictEqual(exec(e, 'DBSIZE'), 0);
  assert.deepStrictEqual(exec(e, 'KEYS', '*'), []);
});

test('expiry: SET clears TTL unless KEEPTTL', () => {
  const e = makeEngine();
  exec(e, 'SET', 'k', 'v', 'EX', '100');
  exec(e, 'SET', 'k', 'v2');
  assert.strictEqual(exec(e, 'TTL', 'k'), -1);
  exec(e, 'SET', 'k', 'v3', 'EX', '100');
  exec(e, 'SET', 'k', 'v4', 'KEEPTTL');
  assert.strictEqual(exec(e, 'TTL', 'k') > 0, true);
});

test('keyspace: del/exists/type/rename/copy', () => {
  const e = makeEngine();
  exec(e, 'MSET', 'a', '1', 'b', '2');
  assert.strictEqual(exec(e, 'DEL', 'a', 'zzz'), 1);
  assert.strictEqual(exec(e, 'EXISTS', 'a', 'b'), 1);
  assert.strictEqual(exec(e, 'TYPE', 'b'), 'string');
  assert.strictEqual(exec(e, 'TYPE', 'nope'), 'none');
  assert.strictEqual(exec(e, 'RENAME', 'b', 'c'), 'OK');
  assert.strictEqual(exec(e, 'GET', 'c').toString(), '2');
  assert.strictEqual(exec(e, 'COPY', 'c', 'd'), 1);
  assert.strictEqual(exec(e, 'GET', 'd').toString(), '2');
  assert.strictEqual(exec(e, 'RENAME', 'missing', 'x').error, 'ERR no such key');
});

test('keyspace: keys pattern, scan, dbsize', () => {
  const e = makeEngine();
  exec(e, 'MSET', 'user:1', 'a', 'user:2', 'b', 'order:1', 'c');
  const keys = exec(e, 'KEYS', 'user:*').map((b) => b.toString()).sort();
  assert.deepStrictEqual(keys, ['user:1', 'user:2']);
  const [cursor, batch] = exec(e, 'SCAN', '0', 'COUNT', '2');
  assert.strictEqual(batch.length, 2);
  assert.notStrictEqual(Number(cursor.toString()), 0);
  const [cursor2, batch2] = exec(e, 'SCAN', cursor, 'MATCH', '*', 'COUNT', '100');
  assert.strictEqual(Number(cursor2.toString()), 0);
  assert.strictEqual(batch2.length, 1);
  assert.strictEqual(exec(e, 'DBSIZE'), 3);
});

test('lists: push/pop/llen/lindex/lrange/trim/lrem', () => {
  const e = makeEngine();
  assert.strictEqual(exec(e, 'RPUSH', 'l', 'a', 'b', 'c'), 3);
  assert.strictEqual(exec(e, 'LPUSH', 'l', 'z'), 4);
  assert.deepStrictEqual(exec(e, 'LRANGE', 'l', '0', '-1').map((b) => b.toString()), ['z', 'a', 'b', 'c']);
  assert.strictEqual(exec(e, 'LLEN', 'l'), 4);
  assert.strictEqual(exec(e, 'LINDEX', 'l', '0').toString(), 'z');
  assert.strictEqual(exec(e, 'LINDEX', 'l', '-1').toString(), 'c');
  assert.strictEqual(exec(e, 'LPOP', 'l').toString(), 'z');
  assert.strictEqual(exec(e, 'RPOP', 'l').toString(), 'c');
  assert.deepStrictEqual(exec(e, 'LPOP', 'l', '5').map((b) => b.toString()), ['a', 'b']);
  assert.strictEqual(exec(e, 'LLEN', 'l'), 0);
  assert.strictEqual(exec(e, 'EXISTS', 'l'), 0);
});

test('lists: lset/linsert/ltrim/lmove', () => {
  const e = makeEngine();
  exec(e, 'RPUSH', 'l', 'a', 'b', 'c');
  assert.strictEqual(exec(e, 'LSET', 'l', '1', 'B'), 'OK');
  assert.strictEqual(exec(e, 'LINDEX', 'l', '1').toString(), 'B');
  assert.strictEqual(exec(e, 'LINSERT', 'l', 'BEFORE', 'B', 'X'), 4);
  assert.deepStrictEqual(exec(e, 'LRANGE', 'l', '0', '-1').map((b) => b.toString()), ['a', 'X', 'B', 'c']);
  exec(e, 'LTRIM', 'l', '1', '2');
  assert.deepStrictEqual(exec(e, 'LRANGE', 'l', '0', '-1').map((b) => b.toString()), ['X', 'B']);
  exec(e, 'DEL', 'src', 'dst');
  exec(e, 'RPUSH', 'src', '1', '2');
  assert.strictEqual(exec(e, 'LMOVE', 'src', 'dst', 'LEFT', 'RIGHT').toString(), '1');
  assert.strictEqual(exec(e, 'LMOVE', 'src', 'dst', 'LEFT', 'RIGHT').toString(), '2');
  assert.strictEqual(exec(e, 'EXISTS', 'src'), 0);
  assert.strictEqual(exec(e, 'LLEN', 'dst'), 2);
});

test('sets: sadd/srem/sismember/smembers', () => {
  const e = makeEngine();
  assert.strictEqual(exec(e, 'SADD', 's', 'a', 'b', 'a'), 2);
  assert.strictEqual(exec(e, 'SCARD', 's'), 2);
  assert.strictEqual(exec(e, 'SISMEMBER', 's', 'a'), 1);
  assert.strictEqual(exec(e, 'SISMEMBER', 's', 'z'), 0);
  assert.deepStrictEqual(exec(e, 'SMISMEMBER', 's', 'a', 'z'), [1, 0]);
  assert.strictEqual(exec(e, 'SREM', 's', 'a', 'zz'), 1);
  const members = exec(e, 'SMEMBERS', 's').map((b) => b.toString()).sort();
  assert.deepStrictEqual(members, ['b']);
});

test('sets: union/inter/diff + stores', () => {
  const e = makeEngine();
  exec(e, 'SADD', 's1', 'a', 'b', 'c');
  exec(e, 'SADD', 's2', 'b', 'c', 'd');
  const uni = exec(e, 'SUNION', 's1', 's2').map((b) => b.toString()).sort();
  assert.deepStrictEqual(uni, ['a', 'b', 'c', 'd']);
  const inter = exec(e, 'SINTER', 's1', 's2').map((b) => b.toString()).sort();
  assert.deepStrictEqual(inter, ['b', 'c']);
  const diff = exec(e, 'SDIFF', 's1', 's2').map((b) => b.toString());
  assert.deepStrictEqual(diff, ['a']);
  assert.strictEqual(exec(e, 'SINTERSTORE', 'out', 's1', 's2'), 2);
  assert.strictEqual(exec(e, 'TYPE', 'out'), 'set');
});

test('zsets: zadd/zscore/zrange/zrank/zcount', () => {
  const e = makeEngine();
  assert.strictEqual(exec(e, 'ZADD', 'z', '1', 'one', '2', 'two', '3', 'three'), 3);
  assert.strictEqual(exec(e, 'ZSCORE', 'z', 'two').toString(), '2');
  assert.strictEqual(exec(e, 'ZCARD', 'z'), 3);
  assert.deepStrictEqual(exec(e, 'ZRANGE', 'z', '0', '-1').map((b) => b.toString()), ['one', 'two', 'three']);
  assert.deepStrictEqual(exec(e, 'ZREVRANGE', 'z', '0', '0').map((b) => b.toString()), ['three']);
  assert.strictEqual(exec(e, 'ZRANK', 'z', 'two'), 1);
  assert.strictEqual(exec(e, 'ZREVRANK', 'z', 'two'), 1);
  assert.strictEqual(exec(e, 'ZCOUNT', 'z', '(1', '3'), 2);
  assert.strictEqual(exec(e, 'ZADD', 'z', 'GT', 'CH', '5', 'two'), 1);
  assert.strictEqual(exec(e, 'ZSCORE', 'z', 'two').toString(), '5');
  assert.strictEqual(exec(e, 'ZADD', 'z', 'NX', '5', 'two'), 0);
  assert.strictEqual(exec(e, 'ZINCRBY', 'z', '2', 'one').toString(), '3');
});

test('zsets: zincrby, withscores, byscore, lex, pop', () => {
  const e = makeEngine();
  exec(e, 'ZADD', 'z', '1', 'a', '2', 'b', '3', 'c');
  const ws = exec(e, 'ZRANGE', 'z', '0', '-1', 'WITHSCORES').map((b) => b.toString());
  assert.deepStrictEqual(ws, ['a', '1', 'b', '2', 'c', '3']);
  assert.deepStrictEqual(exec(e, 'ZRANGEBYSCORE', 'z', '(1', '+inf').map((b) => b.toString()), ['b', 'c']);
  assert.deepStrictEqual(exec(e, 'ZREVRANGEBYSCORE', 'z', '3', '2').map((b) => b.toString()), ['c', 'b']);
  exec(e, 'ZADD', 'lex', '0', 'a', '0', 'b', '0', 'c');
  assert.deepStrictEqual(exec(e, 'ZRANGEBYLEX', 'lex', '[a', '(c').map((b) => b.toString()), ['a', 'b']);
  const popped = exec(e, 'ZPOPMIN', 'z');
  assert.deepStrictEqual(popped.map((b) => b.toString()), ['a', '1']);
  assert.strictEqual(exec(e, 'ZREM', 'z', 'b', 'zzz'), 1);
  assert.strictEqual(exec(e, 'ZCARD', 'z'), 1);
});

test('zsets: zunionstore/zinterstore', () => {
  const e = makeEngine();
  exec(e, 'ZADD', 'z1', '1', 'a', '2', 'b');
  exec(e, 'ZADD', 'z2', '10', 'b', '20', 'c');
  assert.strictEqual(exec(e, 'ZUNIONSTORE', 'out', '2', 'z1', 'z2'), 3);
  assert.strictEqual(exec(e, 'ZSCORE', 'out', 'b').toString(), '12');
  assert.strictEqual(exec(e, 'ZUNIONSTORE', 'out2', '2', 'z1', 'z2', 'WEIGHTS', '2', '3'), 3);
  assert.strictEqual(exec(e, 'ZSCORE', 'out2', 'b').toString(), '34');
  assert.strictEqual(exec(e, 'ZINTERSTORE', 'out3', '2', 'z1', 'z2'), 1);
  assert.strictEqual(exec(e, 'ZSCORE', 'out3', 'b').toString(), '12');
});

test('hashes: hset/hget/hgetall/hdel/hexists', () => {
  const e = makeEngine();
  assert.strictEqual(exec(e, 'HSET', 'h', 'f1', 'v1', 'f2', 'v2'), 2);
  assert.strictEqual(exec(e, 'HGET', 'h', 'f1').toString(), 'v1');
  assert.strictEqual(exec(e, 'HGET', 'h', 'nope'), null);
  assert.strictEqual(exec(e, 'HSET', 'h', 'f1', 'v1b'), 0);
  assert.strictEqual(exec(e, 'HGET', 'h', 'f1').toString(), 'v1b');
  assert.strictEqual(exec(e, 'HEXISTS', 'h', 'f2'), 1);
  assert.strictEqual(exec(e, 'HLEN', 'h'), 2);
  assert.strictEqual(exec(e, 'HSTRLEN', 'h', 'f1'), 3);
  assert.deepStrictEqual(exec(e, 'HKEYS', 'h').map((b) => b.toString()).sort(), ['f1', 'f2']);
  assert.deepStrictEqual(exec(e, 'HVALS', 'h').map((b) => b.toString()).sort(), ['v1b', 'v2']);
  assert.deepStrictEqual(exec(e, 'HMGET', 'h', 'f1', 'zz').map((b) => (b ? b.toString() : null)), ['v1b', null]);
  const all = exec(e, 'HGETALL', 'h').map((b) => b.toString());
  assert.deepStrictEqual(all.sort(), ['f1', 'f2', 'v1b', 'v2']);
  assert.strictEqual(exec(e, 'HDEL', 'h', 'f1', 'zz'), 1);
  assert.strictEqual(exec(e, 'HLEN', 'h'), 1);
});

test('hashes: hsetnx/hincrby/hincrbyfloat', () => {
  const e = makeEngine();
  assert.strictEqual(exec(e, 'HSETNX', 'h', 'n', '5'), 1);
  assert.strictEqual(exec(e, 'HSETNX', 'h', 'n', '9'), 0);
  assert.strictEqual(exec(e, 'HINCRBY', 'h', 'n', '3').toString(), '8');
  assert.strictEqual(exec(e, 'HINCRBYFLOAT', 'h', 'n', '0.5').toString(), '8.5');
  exec(e, 'HSET', 'h', 's', 'abc');
  assert.ok(exec(e, 'HINCRBY', 'h', 's', '1').error);
});

test('wrongtype errors', () => {
  const e = makeEngine();
  exec(e, 'SET', 'k', 'v');
  assert.ok(exec(e, 'LPUSH', 'k', 'x').error.includes('WRONGTYPE'));
  assert.ok(exec(e, 'SADD', 'k', 'x').error.includes('WRONGTYPE'));
  assert.ok(exec(e, 'ZADD', 'k', '1', 'x').error.includes('WRONGTYPE'));
  assert.ok(exec(e, 'HSET', 'k', 'f', 'x').error.includes('WRONGTYPE'));
});

test('quota: max value size', () => {
  const e = makeEngine({ maxValueBytes: 8 });
  assert.strictEqual(exec(e, 'SET', 'k', '12345678'), 'OK');
  const err = exec(e, 'SET', 'k2', '123456789');
  assert.ok(err.error.includes('maximum value size'));
});

test('quota: max keys', () => {
  const e = makeEngine({ maxKeys: 2 });
  assert.strictEqual(exec(e, 'SET', 'a', '1'), 'OK');
  assert.strictEqual(exec(e, 'SET', 'b', '1'), 'OK');
  assert.ok(exec(e, 'SET', 'c', '1').error.includes('key limit'));
});

test('quota: memory accounting recovers on delete and expiry', () => {
  const e = makeEngine({ maxMemoryBytes: 4096 });
  exec(e, 'SET', 'big', 'x'.repeat(512));
  exec(e, 'SET', 'big2', 'x'.repeat(512));
  exec(e, 'DEL', 'big');
  assert.strictEqual(exec(e, 'SET', 'big3', 'x'.repeat(512)), 'OK');
  exec(e, 'SETEX', 'k', '1', 'v');
  assert.strictEqual(exec(e, 'SETEX', 'k', '1', 'v'), 'OK');
});

test('dispatch: unknown command and arity errors', () => {
  const e = makeEngine();
  assert.ok(exec(e, 'NOSUCHCMD').error.includes('unknown command'));
  assert.ok(exec(e, 'MSET', 'onlykey').error.includes('wrong number'));
});

test('dispatch: internal helpers are not callable as commands', () => {
  const e = makeEngine();
  assert.ok(exec(e, '_INCRBY', 'k', '5').error.includes('unknown command'));
  assert.ok(exec(e, 'EXECUTE', 'GET', 'x').error.includes('unknown command'));
});
