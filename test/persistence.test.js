'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.REDEX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'redex-persist-'));
const config = require('../src/config');
const { Engine } = require('../src/engine/engine');
const { Persistence } = require('../src/engine/persistence');

function exec(e, ...args) {
  return e.execute(args.map((a) => Buffer.from(String(a), 'utf8')));
}

test('persistence: AOF replay restores strings, hashes, lists, counters', () => {
  const dir = path.join(config.dataDir, 'db_aof1');
  fs.rmSync(dir, { recursive: true, force: true });

  const e1 = new Engine({ name: 'db_aof1', limits: { maxKeys: 100, maxMemoryBytes: 0, maxValueBytes: 1024 } });
  const p1 = new Persistence('db_aof1', config.dataDir, e1, { aofEnabled: true });
  exec(e1, 'SET', 'name', 'alice');
  p1.append(['SET', 'name', 'alice']);
  exec(e1, 'INCR', 'hits');
  p1.append(['INCR', 'hits']);
  exec(e1, 'INCR', 'hits');
  p1.append(['INCR', 'hits']);
  exec(e1, 'HSET', 'user:1', 'email', 'a@b.c', 'age', '33');
  p1.append(['HSET', 'user:1', 'email', 'a@b.c', 'age', '33']);
  exec(e1, 'RPUSH', 'queue', 't1', 't2');
  p1.append(['RPUSH', 'queue', 't1', 't2']);

  // Fresh engine, same on-disk state.
  const e2 = new Engine({ name: 'db_aof1', limits: { maxKeys: 100, maxMemoryBytes: 0, maxValueBytes: 1024 } });
  const p2 = new Persistence('db_aof1', config.dataDir, e2, { aofEnabled: true });
  const st = p2.load();
  assert.strictEqual(st.aofCommands, 5);
  assert.strictEqual(exec(e2, 'GET', 'name').toString(), 'alice');
  assert.strictEqual(exec(e2, 'GET', 'hits').toString(), '2');
  assert.strictEqual(exec(e2, 'INCR', 'hits'), 3);
  const h = exec(e2, 'HGET', 'user:1', 'age');
  assert.strictEqual(h.toString(), '33');
  assert.deepStrictEqual(exec(e2, 'LRANGE', 'queue', '0', '-1').map((b) => b.toString()), ['t1', 't2']);
});

test('persistence: RDB snapshot round-trips all types + expiry', () => {
  const dbId = 'db_rdb1';
  const dir = path.join(config.dataDir, dbId);
  fs.rmSync(dir, { recursive: true, force: true });

  const e1 = new Engine({ name: dbId, limits: { maxKeys: 100, maxMemoryBytes: 0, maxValueBytes: 1024 } });
  const p1 = new Persistence(dbId, config.dataDir, e1, { aofEnabled: false });
  exec(e1, 'SET', 'str', 'hello');
  exec(e1, 'SET', 'bin', '\u00e9\u00e8'); // multi-byte utf8 exercises base64
  exec(e1, 'RPUSH', 'list', 'a', 'b');
  exec(e1, 'SADD', 'set', 'x', 'y');
  exec(e1, 'ZADD', 'z', '1.5', 'm');
  exec(e1, 'HSET', 'h', 'f', 'v');
  exec(e1, 'SET', 'temp', 'gone-soon', 'EX', '1000');
  p1.saveRdb();

  const e2 = new Engine({ name: dbId, limits: { maxKeys: 100, maxMemoryBytes: 0, maxValueBytes: 1024 } });
  const p2 = new Persistence(dbId, config.dataDir, e2, { aofEnabled: false });
  const st = p2.load();
  assert.strictEqual(st.snapshotKeys, 7);
  assert.strictEqual(exec(e2, 'GET', 'str').toString(), 'hello');
  assert.strictEqual(exec(e2, 'GET', 'bin').toString(), '\u00e9\u00e8');
  assert.deepStrictEqual(exec(e2, 'LRANGE', 'list', '0', '-1').map((b) => b.toString()), ['a', 'b']);
  assert.deepStrictEqual(exec(e2, 'SMEMBERS', 'set').map((b) => b.toString()).sort(), ['x', 'y']);
  assert.strictEqual(exec(e2, 'ZSCORE', 'z', 'm').toString(), '1.5');
  assert.strictEqual(exec(e2, 'HGET', 'h', 'f').toString(), 'v');
  assert.ok(exec(e2, 'TTL', 'temp') > 0);
  assert.strictEqual(exec(e2, 'TYPE', 'z'), 'zset');
  assert.strictEqual(exec(e2, 'TYPE', 'list'), 'list');
});

test('persistence: expired keys do not survive reload', () => {
  const dbId = 'db_exp1';
  const dir = path.join(config.dataDir, dbId);
  fs.rmSync(dir, { recursive: true, force: true });

  const base = Date.now() - 60_000;
  const e1 = new Engine({
    name: dbId,
    limits: { maxKeys: 10, maxMemoryBytes: 0, maxValueBytes: 1024 },
    nowFn: () => base,
  });
  const p1 = new Persistence(dbId, config.dataDir, e1, { aofEnabled: true });
  exec(e1, 'SET', 'k', 'v', 'EX', '10'); // expires at base+10s, long past now
  p1.append(['SET', 'k', 'v', 'EX', '10']);

  const e2 = new Engine({ name: dbId, limits: { maxKeys: 10, maxMemoryBytes: 0, maxValueBytes: 1024 } });
  const p2 = new Persistence(dbId, config.dataDir, e2, { aofEnabled: true });
  p2.load();
  assert.strictEqual(exec(e2, 'GET', 'k'), null);
  assert.strictEqual(exec(e2, 'TTL', 'k'), -2);
  assert.strictEqual(exec(e2, 'DBSIZE'), 0);
});

test('persistence: rewrite resets AOF after snapshot', () => {
  const dbId = 'db_rw1';
  const dir = path.join(config.dataDir, dbId);
  fs.rmSync(dir, { recursive: true, force: true });

  const e1 = new Engine({ name: dbId, limits: { maxKeys: 100, maxMemoryBytes: 0, maxValueBytes: 1024 } });
  const p1 = new Persistence(dbId, config.dataDir, e1, { aofEnabled: true });
  for (let i = 0; i < 100; i++) {
    exec(e1, 'INCR', 'ctr');
    p1.append(['INCR', 'ctr']);
  }
  assert.ok(p1.aofSeq > 0);
  p1.rewrite();
  assert.strictEqual(p1.aofSeq, 0);

  const e2 = new Engine({ name: dbId, limits: { maxKeys: 100, maxMemoryBytes: 0, maxValueBytes: 1024 } });
  const p2 = new Persistence(dbId, config.dataDir, e2, { aofEnabled: true });
  p2.load();
  assert.strictEqual(exec(e2, 'GET', 'ctr').toString(), '100');
});

test('persistence: destroy removes files', () => {
  const dbId = 'db_gone';
  const e1 = new Engine({ name: dbId, limits: { maxKeys: 10, maxMemoryBytes: 0, maxValueBytes: 1024 } });
  const p1 = new Persistence(dbId, config.dataDir, e1, { aofEnabled: true });
  exec(e1, 'SET', 'x', 'y');
  p1.append(['SET', 'x', 'y']);
  p1.close();
  assert.ok(fs.existsSync(path.join(config.dataDir, dbId, 'appendonly.aof')));
  p1.destroy();
  assert.ok(!fs.existsSync(path.join(config.dataDir, dbId)));
});
