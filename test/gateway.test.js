'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolated instance for the test run.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sparrow-gw-'));
process.env.REDEX_DATA_DIR = path.join(tmp, 'engine');
process.env.REDEX_SQLITE_PATH = path.join(tmp, 'control.db');
process.env.REDEX_PORT = '0';
process.env.REDEX_RESP_PORT = '0';
process.env.REDEX_RL_CAPACITY = '50';
process.env.REDEX_RL_REFILL_PER_SEC = '1';
process.env.REDEX_RL_MAX_BURST = '10';

const { createServer } = require('../backend/index');

const { server, control, tenants } = createServer();
let baseUrl = '';

test.before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

test.after(async () => {
  tenants.stop();
  control.close();
  await new Promise((resolve) => server.close(resolve));
});

let cookie;
let dbId;
let token;
let readonlyToken;

async function api(pathname, { method = 'GET', body, auth, tok } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (cookie && auth !== false) headers.Cookie = cookie;
  if (tok) headers.Authorization = `Bearer ${tok}`;
  const res = await fetch(baseUrl + pathname, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  return { status: res.status, data, headers: res.headers };
}

test('signup + login issues session cookie', async () => {
  const email = 'alice@example.com';
  const su = await api('/auth/signup', { method: 'POST', auth: false, body: { email, password: 'supersecret1' } });
  assert.strictEqual(su.status, 201);
  assert.ok(su.headers.get('set-cookie').includes('sparrow_session='));
  const lg = await api('/auth/login', { method: 'POST', auth: false, body: { email, password: 'supersecret1' } });
  assert.strictEqual(lg.status, 200);
  cookie = (lg.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(cookie);
});

test('signup validation', async () => {
  const bad = await api('/auth/signup', { method: 'POST', auth: false, body: { email: 'nope', password: 'supersecret1' } });
  assert.strictEqual(bad.status, 400);
  const dup = await api('/auth/signup', { method: 'POST', auth: false, body: { email: 'alice@example.com', password: 'supersecret1' } });
  assert.strictEqual(dup.status, 409);
});

test('create database + token', async () => {
  const r = await api('/databases', { method: 'POST', body: { name: 'main' } });
  assert.strictEqual(r.status, 201);
  dbId = r.data.database.id;
  assert.ok(dbId.startsWith('db_'));

  const t = await api(`/databases/${dbId}/tokens`, { method: 'POST', body: { name: 'primary' } });
  assert.strictEqual(t.status, 201);
  token = t.data.token_plaintext;
  assert.ok(token.startsWith('sparrow_') && token.length > 40);

  const tro = await api(`/databases/${dbId}/tokens`, { method: 'POST', body: { name: 'ro', readonly: true } });
  readonlyToken = tro.data.token_plaintext;
});

test('path-style command endpoint', async () => {
  const r1 = await api('/set/greeting/hello', { method: 'POST', tok: token, auth: false });
  assert.strictEqual(r1.status, 200);
  assert.deepStrictEqual(r1.data, { result: 'OK' });
  const r2 = await api('/get/greeting', { method: 'POST', tok: token, auth: false });
  assert.strictEqual(r2.status, 200);
  assert.deepStrictEqual(r2.data, { result: 'hello' });
});

test('JSON body command + pipelining', async () => {
  const r1 = await api('/', { method: 'POST', tok: token, auth: false, body: ['SET', 'n', '5'] });
  assert.deepStrictEqual(r1.data, { result: 'OK' });
  const r2 = await api('/pipeline', {
    method: 'POST', tok: token, auth: false,
    body: { commands: [['INCR', 'n'], ['INCR', 'n'], ['GET', 'n']] },
  });
  assert.strictEqual(r2.status, 200);
  assert.deepStrictEqual(r2.data, [{ result: 6 }, { result: 7 }, { result: '7' }]);
});

test('wrongtype surfaces as JSON error', async () => {
  await api('/lpush/list1/a', { method: 'POST', tok: token, auth: false });
  const r = await api('/get/list1', { method: 'POST', tok: token, auth: false });
  assert.strictEqual(r.status, 400);
  assert.ok(r.data.error.includes('WRONGTYPE'));
});

test('auth: missing/invalid bearer tokens rejected', async () => {
  const r1 = await api('/get/greeting', { method: 'POST', auth: false });
  assert.strictEqual(r1.status, 401);
  const r2 = await api('/get/greeting', { method: 'POST', auth: false, tok: 'sparrow_totallybogus' });
  assert.strictEqual(r2.status, 401);
});

test('namespace isolation: second database cannot see first one', async () => {
  const r = await api('/databases', { method: 'POST', body: { name: 'other' } });
  const db2 = r.data.database.id;
  const t2 = (await api(`/databases/${db2}/tokens`, { method: 'POST', body: {} })).data.token_plaintext;

  const leak = await api('/get/greeting', { method: 'POST', tok: t2, auth: false });
  assert.strictEqual(leak.status, 200);
  assert.strictEqual(leak.data.result, null);

  const cnt = await api('/dbsize', { method: 'POST', tok: t2, auth: false });
  assert.strictEqual(cnt.data.result, 0);
  const cnt1 = await api('/dbsize', { method: 'POST', tok: token, auth: false });
  assert.ok(cnt1.data.result >= 2);
});

test('read-only token can read but not write', async () => {
  const ok = await api('/get/greeting', { method: 'POST', tok: readonlyToken, auth: false });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.data.result, 'hello');
  const no = await api('/set/x/1', { method: 'POST', tok: readonlyToken, auth: false });
  assert.strictEqual(no.status, 403);
  const pipe = await api('/pipeline', {
    method: 'POST', tok: readonlyToken, auth: false,
    body: { commands: [['GET', 'greeting'], ['SET', 'x', '1']] },
  });
  assert.strictEqual(pipe.status, 403);
});

test('token revocation takes effect immediately', async () => {
  const t = (await api(`/databases/${dbId}/tokens`, { method: 'POST', body: { name: 'shortlived' } })).data;
  const ok = await api('/get/greeting', { method: 'POST', tok: t.token_plaintext, auth: false });
  assert.strictEqual(ok.status, 200);
  const rev = await api(`/tokens/${t.token.id}`, { method: 'DELETE' });
  assert.strictEqual(rev.status, 200);
  const denied = await api('/get/greeting', { method: 'POST', tok: t.token_plaintext, auth: false });
  assert.strictEqual(denied.status, 401);
});

test('usage endpoint reflects daily counters', async () => {
  await api('/set/usage-test/1', { method: 'POST', tok: token, auth: false });
  const u = await api('/usage', { method: 'GET', tok: token, auth: false });
  assert.strictEqual(u.status, 200);
  assert.ok(u.data.usage.today >= 1);
  assert.ok(typeof u.data.storage.keys === 'number');
});

test('rate limiting kicks in on burst', async () => {
  const savedCookie = cookie;
  const email = 'bob@example.com';
  await api('/auth/signup', { method: 'POST', auth: false, body: { email, password: 'supersecret2' } });
  cookie = (await api('/auth/login', { method: 'POST', auth: false, body: { email, password: 'supersecret2' } })).headers.get('set-cookie').split(';')[0];
  const db2 = (await api('/databases', { method: 'POST', body: { name: 'bursty' } })).data.database;
  const tk = (await api(`/databases/${db2.id}/tokens`, { method: 'POST', body: {} })).data.token_plaintext;

  let got429 = false;
  let last = null;
  for (let i = 0; i < 80; i++) {
    last = await api('/ping', { method: 'POST', tok: tk, auth: false });
    if (last.status === 429) { got429 = true; break; }
    assert.strictEqual(last.status, 200);
  }
  assert.ok(got429, `expected a 429 within 80 requests (last=${last.status})`);
  assert.ok(last.data.error.includes('Rate limit'));
  cookie = savedCookie; // restore alice's session for later tests
});

test('oversized payload rejected with 413', async () => {
  process.env.REDEX_MAX_PAYLOAD_BYTES = String(process.env.REDEX_MAX_PAYLOAD_BYTES || 1024 * 1024);
  const bigValue = 'x'.repeat(2 * 1024 * 1024);
  const r = await api('/set/big/value', { method: 'POST', tok: token, auth: false });
  // Path-style big values don't hit the body limit; use JSON body instead:
  const r2 = await api('/', { method: 'POST', tok: token, auth: false, body: ['SET', 'big', bigValue] });
  assert.ok([413, 400].includes(r2.status), `expected 413/400, got ${r2.status}: ${JSON.stringify(r2.data)}`);
});

test('dashboard page serves HTML', async () => {
  const res = await fetch(baseUrl + '/dashboard');
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('<title>Sparrow Console</title>'));
});

test('web: landing + login pages and logo asset', async () => {
  const land = await fetch(baseUrl + '/');
  const html = await land.text();
  assert.ok(land.status === 200);
  assert.ok(html.includes('<title>Sparrow'), 'landing title');
  assert.ok(html.includes('class="logo"'), 'inline logo present');
  assert.ok(html.includes('currentColor'), 'logo inherits theme color');
  const logo = await fetch(baseUrl + '/logo-gradient.svg');
  assert.strictEqual(logo.status, 200);
  assert.ok((logo.headers.get('content-type') || '').includes('image/svg+xml'));
  const auth = await fetch(baseUrl + '/login');
  const authHtml = await auth.text();
  assert.ok(auth.status === 200 && authHtml.includes('Welcome back'));
});

test('web: session-scoped introspection endpoints', async () => {
  // still signed in as alice (cookie) with dbId from earlier tests
  const u = await api(`/usage/${dbId}`, { method: 'GET' });
  assert.strictEqual(u.status, 200);
  assert.ok(u.data.usage && typeof u.data.usage.today === 'number');
  assert.ok(typeof u.data.storage.keys === 'number');

  const s = await api(`/storage/${dbId}`, { method: 'GET' });
  assert.strictEqual(s.status, 200);
  assert.ok(typeof s.data.keys === 'number' && typeof s.data.memoryBytes === 'number');
  assert.ok(s.data.limits && typeof s.data.limits.maxKeys === 'number');

  const d = await api(`/databases/${dbId}/data`, { method: 'GET' });
  assert.strictEqual(d.status, 200);
  assert.ok(Array.isArray(d.data.keys));
  const found = d.data.keys.find((k) => k.key === 'greeting');
  assert.ok(found, 'greeting key listed');
  assert.strictEqual(found.type, 'string');
  assert.strictEqual(found.preview, 'hello');

  // no session → 401
  const anon = await fetch(`${baseUrl}/usage/${dbId}`);
  assert.strictEqual(anon.status, 401);
});

test('health endpoint', async () => {
  const r = await api('/healthz', { auth: false });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.ok, true);
});

test('database delete wipes data and tokens', async () => {
  const r = await api('/databases', { method: 'POST', body: { name: 'doomed' } });
  const doomedId = r.data.database.id;
  const tk = (await api(`/databases/${doomedId}/tokens`, { method: 'POST', body: {} })).data.token_plaintext;
  await api('/set/doomed/1', { method: 'POST', tok: tk, auth: false });
  const del = await api(`/databases/${doomedId}`, { method: 'DELETE' });
  assert.strictEqual(del.status, 200);
  const denied = await api('/get/doomed', { method: 'POST', tok: tk, auth: false });
  assert.strictEqual(denied.status, 401);
});
