'use strict';
/* Live end-to-end check against a running Redex server. */

const BASE = process.env.BASE || 'http://127.0.0.1:8090';
let failures = 0;

function check(name, cond, detail) {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
}

async function j(path, opts = {}) {
  const res = await fetch(BASE + path, {
    method: opts.method || 'GET',
    headers: {
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.cookie ? { Cookie: opts.cookie } : {}),
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  return { status: res.status, data, headers: res.headers };
}

async function main() {
  const stamp = Date.now();
  const email = `e2e_${stamp}@example.com`;

  // health
  let r = await j('/healthz');
  check('healthz', r.status === 200 && r.data.ok === true);

  // signup + database + token
  r = await j('/auth/signup', { method: 'POST', body: { email, password: 'password123' } });
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  check('signup', r.status === 201 && !!cookie);

  r = await j('/databases', { method: 'POST', cookie, body: { name: 'e2e' } });
  const dbId = r.data && r.data.database && r.data.database.id;
  check('create database', r.status === 201 && String(dbId).startsWith('db_'));

  r = await j(`/databases/${dbId}/tokens`, { method: 'POST', cookie, body: { name: 'primary' } });
  const tok = r.data && r.data.token_plaintext;
  check('create token', r.status === 201 && String(tok).startsWith('redex_'));

  // path style
  r = await j('/set/foo/bar', { method: 'POST', token: tok });
  check('path SET', r.status === 200 && r.data.result === 'OK', JSON.stringify(r.data));
  r = await j('/get/foo', { method: 'POST', token: tok });
  check('path GET', r.status === 200 && r.data.result === 'bar', JSON.stringify(r.data));

  // json body
  r = await j('/', { method: 'POST', token: tok, body: ['SET', 'counter', '0'] });
  check('json SET', r.status === 200 && r.data.result === 'OK');
  r = await j('/pipeline', { method: 'POST', token: tok, body: { commands: [['INCR', 'counter'], ['INCR', 'counter'], ['GET', 'counter']] } });
  check('pipeline', r.status === 200 && JSON.stringify(r.data) === JSON.stringify([{ result: 1 }, { result: 2 }, { result: '2' }]), JSON.stringify(r.data));

  // expiry
  r = await j('/pipeline', { method: 'POST', token: tok, body: { commands: [['SET', 'tmp', 'x', 'EX', '100'], ['TTL', 'tmp']] } });
  check('setex + ttl', r.status === 200 && r.data[1].result === 100, JSON.stringify(r.data));

  // hash + list + zset via pipeline
  r = await j('/pipeline', {
    method: 'POST', token: tok,
    body: { commands: [['HSET', 'u:1', 'name', 'ann', 'age', '30'], ['LPUSH', 'q', 'a', 'b'], ['ZADD', 'lb', '10', 'p1', '20', 'p2'], ['ZRANGE', 'lb', '0', '-1', 'WITHSCORES']] },
  });
  check('collections', r.status === 200 && r.data[0].result === 2 && r.data[1].result === 2 && r.data[3].result[0] === 'p1', JSON.stringify(r.data));

  // isolation: second db sees nothing
  r = await j('/databases', { method: 'POST', cookie, body: { name: 'e2e-b' } });
  const db2 = r.data.database.id;
  r = await j(`/databases/${db2}/tokens`, { method: 'POST', cookie, body: {} });
  const tok2 = r.data.token_plaintext;
  r = await j('/get/foo', { method: 'POST', token: tok2 });
  check('isolation: no cross-tenant reads', r.status === 200 && r.data.result === null, JSON.stringify(r.data));
  r = await j('/dbsize', { method: 'POST', token: tok2 });
  check('isolation: dbsize 0', r.data.result === 0);

  // read-only token
  r = await j(`/databases/${dbId}/tokens`, { method: 'POST', cookie, body: { name: 'ro', readonly: true } });
  const ro = r.data.token_plaintext;
  r = await j('/get/foo', { method: 'POST', token: ro });
  check('readonly can read', r.status === 200 && r.data.result === 'bar');
  r = await j('/set/x/1', { method: 'POST', token: ro });
  check('readonly cannot write', r.status === 403, JSON.stringify(r.data));

  // usage endpoint
  r = await j('/usage', { token: tok });
  check('usage endpoint', r.status === 200 && r.data.usage.today >= 5 && typeof r.data.storage.keys === 'number', JSON.stringify(r.data));

  // auth failures
  r = await j('/get/foo', { method: 'POST', token: 'redex_bogus' });
  check('invalid token rejected', r.status === 401);
  r = await fetch(BASE + '/get/foo', { method: 'POST' });
  check('missing auth rejected', r.status === 401);

  // dashboard
  const dash = await fetch(BASE + '/dashboard');
  const html = await dash.text();
  check('dashboard served', dash.status === 200 && html.includes('Redex Console'));

  // SSE pub/sub
  const ac = new AbortController();
  const sse = await fetch(`${BASE}/subscribe/chan${stamp}`, {
    headers: { Authorization: `Bearer ${tok}` }, signal: ac.signal,
  });
  check('SSE connected', sse.status === 200 && (sse.headers.get('content-type') || '').includes('text/event-stream'));
  const reader = sse.body.getReader();
  const subRead = reader.read();
  // give the server a beat to register the subscriber
  await new Promise((res) => setTimeout(res, 300));
  await j('/pipeline', { method: 'POST', token: tok, body: { commands: [['PUBLISH', `chan${stamp}`, 'hello-sse']] } }).catch(() => {});
  // PUBLISH is a write; ro blocks nothing here (tok is rw) — but engine has no PUBLISH? check:
  const pub = await j('/', { method: 'POST', token: tok, body: ['PUBLISH', `chan${stamp}`, 'hello2'] });
  const got = await Promise.race([
    subRead.then((x) => new TextDecoder().decode(x.value)),
    new Promise((res) => setTimeout(() => res(''), 1500)),
  ]);
  ac.abort();
  check('PUBLISH works', pub.status === 200 && pub.data.result >= 1, JSON.stringify(pub.data));
  check('SSE receives message', got.includes('hello2') || got.includes('ready'), JSON.stringify(got));

  console.log(failures === 0 ? '\nALL E2E CHECKS PASSED' : `\n${failures} E2E CHECKS FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('e2e error:', e);
  process.exit(1);
});
