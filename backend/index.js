'use strict';

const http = require('http');
const config = require('./config');
const { ControlService } = require('./control/service');
const { TenantManager } = require('./engine/tenantManager');
const { RateLimiter } = require('./gateway/rateLimiter');
const { Gateway } = require('./gateway');

function createServer(opts = {}) {
  const control = new ControlService({ limits: opts.limits });
  const tenants = new TenantManager({ aofEnabled: config.aofEnabled, aofFsync: config.aofFsync });
  const rateLimiter = new RateLimiter({
    capacity: config.rlCapacity,
    refillPerSec: config.rlRefillPerSec,
    maxBurst: config.rlMaxBurst,
  });
  const gateway = new Gateway({ control, tenants, rateLimiter, config });

  const server = http.createServer((req, res) => gateway.handle(req, res));
  server.keepAliveTimeout = 65_000;

  return { server, control, tenants, gateway, rateLimiter, config };
}

function startRespDebugServer({ control, tenants, config }) {
  if (!config.respPort) return null;
  const { RespServer } = require('./engine/respServer');
  const resp = new RespServer({ control, tenants, host: '127.0.0.1', port: config.respPort });
  resp.start().then(() => {
    console.log(`[sparrow] RESP debug server on redis://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${config.respPort}`);
  }).catch((e) => {
    console.warn(`[sparrow] RESP debug server unavailable: ${e.message}`);
  });
  return resp;
}

function main() {
  const { server, control, tenants, gateway, config: cfg } = createServer();

  tenants.start();
  control.startSessionGc();
  server.listen(cfg.port, cfg.host, () => {
    console.log(`[sparrow] gateway listening on http://${cfg.host}:${cfg.port}`);
    console.log(`[sparrow] landing: http://${cfg.host}:${cfg.port}  ·  console: http://${cfg.host}:${cfg.port}/dashboard`);
    console.log(`[sparrow] data dir: ${cfg.dataDir}`);
  });

  const resp = startRespDebugServer({ control, tenants, config: cfg });

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[sparrow] received ${signal}, flushing and closing...`);
    server.close();
    if (resp) resp.stop();
    tenants.stop();          // flush + snapshot everything
    gateway.stop();
    control.stopSessionGc();
    control.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) {
  main();
}

module.exports = { createServer, startRespDebugServer, main };
