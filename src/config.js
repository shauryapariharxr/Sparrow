'use strict';

const path = require('path');

const int = (name, def) => {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
};

const bool = (name, def) => {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return v !== '0' && v.toLowerCase() !== 'false' && v !== 'no';
};

const root = process.cwd();

const config = {
  host: process.env.REDEX_HOST || '127.0.0.1',
  port: int('REDEX_PORT', 8080),

  sqlitePath: process.env.REDEX_SQLITE_PATH || path.join(root, 'data', 'control.db'),

  dataDir: process.env.REDEX_DATA_DIR || path.join(root, 'data', 'engine'),
  aofEnabled: bool('REDEX_AOF_ENABLED', true),
  aofFsync: ['always', 'everysec', 'no'].includes(process.env.REDEX_AOF_FSYNC)
    ? process.env.REDEX_AOF_FSYNC
    : 'always',
  rdbSaveSeconds: int('REDEX_RDB_SAVE_SECONDS', 900),
  rdbSaveMinChanges: int('REDEX_RDB_SAVE_MIN_CHANGES', 10),

  maxKeys: int('REDEX_MAX_KEYS', 100000),
  maxMemoryBytes: int('REDEX_MAX_MEMORY_BYTES', 128 * 1024 * 1024),
  maxValueBytes: int('REDEX_MAX_VALUE_BYTES', 1024 * 1024),
  maxPayloadBytes: int('REDEX_MAX_PAYLOAD_BYTES', 1024 * 1024),
  maxDbName: int('REDEX_MAX_DB_NAME', 64),
  maxDbPerUser: int('REDEX_MAX_DB_PER_USER', 10),

  rlCapacity: int('REDEX_RL_CAPACITY', 200),
  rlRefillPerSec: int('REDEX_RL_REFILL_PER_SEC', 100),
  rlMaxBurst: int('REDEX_RL_MAX_BURST', 400),

  respPort: int('REDEX_RESP_PORT', 6379),

  sessionTtlHours: int('REDEX_SESSION_TTL_HOURS', 168),
};

config.cookieName = 'redex_session';
config.engineDb = path.join(config.dataDir, 'engine.db');

module.exports = config;
