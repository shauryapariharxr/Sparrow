'use strict';

/**
 * Minimal RESP TCP server for redis-cli debugging. NOT the production data
 * path — binds to loopback only. Clients AUTH with an API token, which maps
 * to that tenant's keyspace, exactly like the REST gateway resolves tokens.
 */

const net = require('net');
const { encode, RespParser, parseInline } = require('./resp');
const { sha256hex } = require('../util');

class RespServer {
  constructor({ tenants, control, host = '127.0.0.1', port = 6379 }) {
    this.tenants = tenants;
    this.control = control;
    this.host = host;
    this.port = port;
    this.server = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this.onConnection(socket));
      server.on('error', reject);
      server.listen(this.port, this.host, () => {
        this.server = server;
        resolve(server);
      });
    });
  }

  stop() {
    if (this.server) {
      return new Promise((resolve) => this.server.close(resolve));
    }
    return Promise.resolve();
  }

  onConnection(socket) {
    const parser = new RespParser();
    let authedDb = null; // set after successful AUTH

    socket.on('data', (chunk) => {
      parser.push(chunk);
      for (;;) {
        const msg = parser.next();
        if (!msg) break;
        if (msg.error) {
          socket.write(encode({ error: msg.error }));
          continue;
        }
        const argv = msg.length > 0 ? msg : parseInline(Buffer.alloc(0));
        if (argv.length === 0) continue;
        const reply = this.dispatch(argv, authedDb, socket);
        socket.write(encode(reply));
        if (String(argv[0]).toUpperCase() === 'QUIT') {
          socket.end();
          break;
        }
      }
    });

    socket.on('error', () => { /* client went away */ });
  }

  dispatch(argv, authedDb, socket) {
    const name = String(argv[0]).toUpperCase();
    const args = argv.slice(1);

    if (name === 'AUTH') {
      const raw = args.length === 2 ? args[1] : args[0]; // AUTH <user> <pass> | AUTH <pass>
      const resolved = this.control.authenticateApiToken(String(raw));
      if (!resolved) return { error: 'ERR invalid API token' };
      authedDb = resolved.db;
      return 'OK';
    }
    if (name === 'HELLO') {
      return { error: 'ERR RESP3 not supported; use RESP2' };
    }
    if (name === 'SELECT') return 'OK';
    if (name === 'CLIENT') return 'OK';
    if (name === 'QUIT') return 'OK';

    if (!authedDb) {
      return { error: 'NOAUTH send AUTH <api-token> first' };
    }

    const tdb = this.tenants.get(authedDb.id, authedDb);
    return tdb.execute(argv);
  }
}

module.exports = { RespServer };
