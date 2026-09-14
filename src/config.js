'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Minimal dotenv-style loader for `.env.local` (then `.env`).
 * Real environment variables always win over file values.
 * Supports comments, [section] headers, quoted values and inline comments.
 */
function loadEnvFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#') || line.startsWith('[')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (!key) continue;
    if ((val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
        (val.startsWith("'") && val.endsWith("'") && val.length >= 2)) {
      val = val.slice(1, -1);
    } else {
      const hash = val.indexOf(' #');
      if (hash !== -1) val = val.slice(0, hash).trim();
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

const root = process.cwd();
loadEnvFile(path.join(root, '.env'));
loadEnvFile(path.join(root, '.env.local')); // higher precedence than .env

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

const config = {
  // PaaS platforms (Render/Railway/Fly) route traffic to 0.0.0.0 and inject
  // PORT; defaulting to that when PORT exists keeps them working with zero
  // dashboard config. Local dev and the systemd unit still default to loopback.
  host: process.env.REDEX_HOST || process.env.SPARROW_HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1'),
  port: int('REDEX_PORT', int('SPARROW_PORT', int('PORT', 8080))),

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

config.cookieName = 'sparrow_session';
config.engineDb = path.join(config.dataDir, 'engine.db');

module.exports = config;
