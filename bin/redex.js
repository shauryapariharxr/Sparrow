#!/usr/bin/env node
'use strict';

/**
 * Sparrow CLI
 *
 *   sparrow up                                   start the server
 *   sparrow signup --email a@b.c --password s    create an account
 *   sparrow create --email a@b.c --password s --name mydb
 *                                                provision a database + token
 *   sparrow call --db db_x --token sparrow_... GET key
 *   sparrow call --db db_x --token sparrow_... '["SET","k","v"]'
 *   sparrow pipe  --db db_x --token sparrow_... '[["SET","k","1"],["INCR","k"]]'
 *   sparrow sub   --db db_x --token sparrow_... mychannel
 */

const args = process.argv.slice(2);
const cmd = args[0] || 'help';

function flag(name, def) {
  const i = args.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= args.length) return def;
  return args[i + 1];
}

function required(name, value) {
  if (value === undefined) {
    console.error(`error: missing required --${name}`);
    process.exit(1);
  }
  return value;
}

function baseUrl() {
  return process.env.SPARROW_URL || process.env.REDEX_URL || `http://127.0.0.1:${process.env.REDEX_PORT || process.env.PORT || 8080}`;
}

async function jsonFetch(path, opts = {}) {
  const res = await fetch(baseUrl() + path, {
    method: opts.method || 'GET',
    headers: {
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.cookie ? { Cookie: opts.cookie } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* keep raw */ }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${(data && data.error) || text}`);
  }
  return { data, setCookie: res.headers.get('set-cookie') };
}

async function loginSession() {
  const email = required('email', flag('email'));
  const password = required('password', flag('password'));
  const { data, setCookie } = await jsonFetch('/auth/login', {
    method: 'POST',
    body: { email, password },
  });
  const cookie = (setCookie || '').split(';')[0];
  return { cookie, user: data.user };
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

async function main() {
  switch (cmd) {
    case 'up': {
      require('../backend/index.js').main();
      break;
    }

    case 'signup': {
      const email = required('email', flag('email'));
      const password = required('password', flag('password'));
      const { data } = await jsonFetch('/auth/signup', { method: 'POST', body: { email, password } });
      console.log(`created account ${data.user.email} (${data.user.id})`);
      break;
    }

    case 'create': {
      const name = required('name', flag('name'));
      const { cookie } = await loginSession();
      const { data: dbRes } = await jsonFetch('/databases', { method: 'POST', body: { name }, cookie });
      const db = dbRes.database;
      const { data: tokRes } = await jsonFetch(`/databases/${db.id}/tokens`, {
        method: 'POST', body: { name: flag('token-name', 'default') }, cookie,
      });
      console.log('database created:');
      console.log(`  id:      ${db.id}`);
      console.log(`  rest:    ${baseUrl()}  (POST /set/key/value, POST / with ["CMD", ...])`);
      console.log(`  token:   ${tokRes.token_plaintext}`);
      console.log('  (token is shown only once — store it now)');
      break;
    }

    case 'call': {
      const token = required('token', flag('token'));
      const rest = args.slice(args.indexOf('--token') + 2).filter((a) => !a.startsWith('--'));
      let body;
      if (rest.length > 0 && Array.isArray(safeParse(rest[0]))) {
        body = safeParse(rest[0]);
      } else if (rest.length > 0) {
        body = rest; // path style: SET key value
      } else {
        const inline = flag('cmd') || args[args.length - 1];
        body = safeParse(inline);
        if (!Array.isArray(body)) throw new Error('expected a command array like ["GET","key"]');
      }
      const { data } = await jsonFetch('/', { method: 'POST', body, token });
      console.log(JSON.stringify(data, null, 2));
      break;
    }

    case 'pipe': {
      const db = required('db', flag('db'));
      const token = required('token', flag('token'));
      const body = JSON.parse(flag('cmds') || args[args.length - 1]);
      const { data } = await jsonFetch('/pipeline', { method: 'POST', body: { commands: body }, token });
      console.log(JSON.stringify(data, null, 2));
      break;
    }

    case 'sub': {
      const token = required('token', flag('token'));
      const channel = required('channel', flag('channel') || args[args.length - 1]);
      const res = await fetch(`${baseUrl()}/subscribe/${encodeURIComponent(channel)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      console.log(`subscribed to "${channel}" — Ctrl+C to exit`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        process.stdout.write(decoder.decode(value));
      }
      break;
    }

    default: {
      console.log(`sparrow — Redis-compatible data stores over HTTPS

usage:
  sparrow up                                   start server (http://127.0.0.1:8080)
  sparrow signup --email E --password P        create an account
  sparrow create --email E --password P --name mydb
                                               provision database + token
  sparrow call --db DBID --token TOK GET key   run one command (path style)
  sparrow call --db DBID --token TOK '["GET","key"]'
  sparrow pipe  --db DBID --token TOK '[["SET","k","1"],["INCR","k"]]'
  sparrow sub   --db DBID --token TOK mychannel

env:
  SPARROW_URL  base URL of a running server (default http://127.0.0.1:8080)`);
      break;
    }
  }
}

main().catch((e) => {
  console.error(`error: ${e.message}`);
  process.exit(1);
});
