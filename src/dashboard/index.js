'use strict';

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Redex Console</title>
<style>
  :root {
    --bg: #0b0e14; --panel: #11151f; --border: #232a3a; --text: #e6e9f0;
    --muted: #8b93a7; --accent: #ff4d4d; --accent2: #6c8cff; --ok: #3fb950; --err: #f85149;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  a { color: var(--accent2); }
  .wrap { max-width: 960px; margin: 0 auto; padding: 24px 16px 80px; }
  header { display: flex; align-items: center; gap: 12px; margin-bottom: 24px; }
  .logo {
    width: 34px; height: 34px; border-radius: 8px; flex: none;
    background: linear-gradient(135deg, #ff4d4d, #b30000);
    display: flex; align-items: center; justify-content: center;
    font-weight: 800; color: #fff; font-size: 18px;
  }
  h1 { font-size: 18px; margin: 0; }
  .muted { color: var(--muted); }
  .panel { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 18px; margin-bottom: 16px; }
  input, button, select {
    font: inherit; color: inherit; background: #0d1117; border: 1px solid var(--border);
    border-radius: 8px; padding: 8px 12px; outline: none;
  }
  input:focus { border-color: var(--accent2); }
  button { cursor: pointer; background: #1a2030; border-color: #2b3550; }
  button:hover { background: #222a3f; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
  button.primary:hover { background: #ff6666; }
  button.ghost { background: transparent; }
  button.danger { color: var(--err); }
  .row { display: flex; gap: 8px; flex-wrap: wrap; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-weight: 500; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; }
  .token { background: #0d1117; border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; overflow-x: auto; }
  .stat { display: inline-block; margin-right: 18px; }
  .stat b { font-size: 16px; }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 99px; font-size: 11px; background: #1a2030; border: 1px solid var(--border); }
  .badge.ro { color: #d29922; }
  #console { width: 100%; min-height: 110px; resize: vertical; white-space: pre; }
  .log { background: #0d1117; border: 1px solid var(--border); border-radius: 8px; padding: 10px; max-height: 260px; overflow: auto; }
  .hidden { display: none; }
  .error { color: var(--err); margin-top: 8px; }
  .ok-msg { color: var(--ok); margin-top: 8px; }
  .kbd { background: #1a2030; border-radius: 4px; padding: 0 6px; font-size: 12px; }
  .hint { font-size: 12px; color: var(--muted); }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="logo">R</div>
    <div>
      <h1>Redex Console</h1>
      <div class="muted">Redis-compatible data stores over HTTPS</div>
    </div>
    <div style="flex:1"></div>
    <button id="logoutBtn" class="ghost hidden">Sign out</button>
  </header>

  <!-- Auth -->
  <div id="authView" class="panel">
    <h2 style="margin-top:0">Sign in</h2>
    <div class="row" style="margin-bottom:8px">
      <input id="email" type="email" placeholder="you@example.com" style="flex:1;min-width:220px">
    </div>
    <div class="row" style="margin-bottom:8px">
      <input id="password" type="password" placeholder="Password (min 8 chars)" style="flex:1;min-width:220px">
    </div>
    <div class="row">
      <button id="loginBtn" class="primary">Sign in</button>
      <button id="signupBtn">Create account</button>
    </div>
    <div id="authMsg" class="error"></div>
  </div>

  <!-- Main -->
  <div id="mainView" class="hidden">
    <div class="panel">
      <h2 style="margin-top:0">Databases</h2>
      <div class="row" style="margin-bottom:12px">
        <input id="newDbName" placeholder="new-database-name" style="flex:1;min-width:200px">
        <button id="createDbBtn" class="primary">Create database</button>
      </div>
      <div id="dbMsg" class="error"></div>
      <table>
        <thead><tr><th>Name</th><th>ID</th><th>Created</th><th></th></tr></thead>
        <tbody id="dbRows"></tbody>
      </table>
    </div>

    <div id="dbDetail" class="panel hidden">
      <h2 id="dbDetailName" style="margin-top:0"></h2>
      <div class="muted mono" id="dbDetailId" style="margin-bottom:12px"></div>

      <h3>REST API</h3>
      <div class="token mono">POST /set/mykey/myvalue<br>POST / &nbsp;body: <span class="kbd">["GET","mykey"]</span><br>GET&nbsp; /subscribe/mychannel</div>

      <h3>Tokens</h3>
      <div class="row" style="margin-bottom:8px">
        <input id="tokName" placeholder="token name" style="flex:1;min-width:160px">
        <label style="display:flex;align-items:center;gap:6px">
          <input type="checkbox" id="tokReadonly" style="width:auto"> read-only
        </label>
        <button id="createTokBtn">Create token</button>
      </div>
      <div id="newTokenBox" class="token mono hidden" style="margin-bottom:8px"></div>
      <table>
        <thead><tr><th>Name</th><th>Prefix</th><th>Access</th><th>Created</th><th></th></tr></thead>
        <tbody id="tokRows"></tbody>
      </table>

      <h3>Usage &amp; storage</h3>
      <div id="usageBox" class="muted">Loading…</div>

      <h3>Try commands</h3>
      <textarea id="console" class="mono" placeholder='["SET","greeting","hello"]'></textarea>
      <div class="row" style="margin-top:8px">
        <button id="runBtn" class="primary">Run</button>
        <span class="hint">Bearer token is filled automatically from the token you create or select.</span>
      </div>
      <div id="consoleLog" class="log mono" style="margin-top:8px"></div>
    </div>
  </div>
</div>

<script>
(function () {
  var state = { user: null, databases: [], currentDb: null, tokens: [], activeToken: null };

  function $(id) { return document.getElementById(id); }
  function show(el) { el.classList.remove('hidden'); }
  function hide(el) { el.classList.add('hidden'); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;' }[c]; }); }

  async function api(path, opts) {
    opts = opts || {};
    var res = await fetch(path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
    });
    var data = null;
    try { data = await res.json(); } catch (e) { /* empty */ }
    if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
    return data;
  }

  function log(line, cls) {
    var d = document.createElement('div');
    if (cls) d.style.color = cls;
    d.textContent = line;
    $('consoleLog').appendChild(d);
    $('consoleLog').scrollTop = $('consoleLog').scrollHeight;
  }

  async function refreshMe() {
    try {
      var r = await api('/auth/me');
      state.user = r.user;
      enterApp();
    } catch (e) {
      showAuth();
    }
  }

  function showAuth() { show($('authView')); hide($('mainView')); hide($('logoutBtn')); }
  function enterApp() {
    hide($('authView')); show($('mainView')); show($('logoutBtn'));
    loadDatabases();
  }

  async function loadDatabases() {
    try {
      var r = await api('/databases');
      state.databases = r.databases || [];
      renderDatabases();
    } catch (e) { $('dbMsg').textContent = e.message; }
  }

  function renderDatabases() {
    var tb = $('dbRows'); tb.innerHTML = '';
    for (var db of state.databases) {
      var tr = document.createElement('tr');
      tr.innerHTML = '<td><a href="#" data-open="' + esc(db.id) + '">' + esc(db.name) + '</a></td>' +
        '<td class="mono muted">' + esc(db.id) + '</td>' +
        '<td class="muted">' + new Date(db.createdAt).toLocaleString() + '</td>' +
        '<td><button class="danger ghost" data-del="' + esc(db.id) + '">delete</button></td>';
      tb.appendChild(tr);
    }
    tb.onclick = function (ev) {
      var open = ev.target.getAttribute && ev.target.getAttribute('data-open');
      var del = ev.target.getAttribute && ev.target.getAttribute('data-del');
      if (open) openDatabase(open);
      if (del) deleteDatabase(del);
    };
  }

  async function openDatabase(id) {
    var db = state.databases.find(function (d) { return d.id === id; });
    if (!db) return;
    state.currentDb = db;
    $('dbDetailName').textContent = db.name;
    $('dbDetailId').textContent = db.id;
    show($('dbDetail'));
    $('newTokenBox').classList.add('hidden');
    $('consoleLog').innerHTML = '';
    await loadTokens();
    await loadUsage();
  }

  async function deleteDatabase(id) {
    if (!confirm('Delete this database and ALL its data? This cannot be undone.')) return;
    await api('/databases/' + id, { method: 'DELETE' });
    if (state.currentDb && state.currentDb.id === id) { state.currentDb = null; hide($('dbDetail')); }
    loadDatabases();
  }

  async function loadTokens() {
    var r = await api('/databases/' + state.currentDb.id + '/tokens');
    state.tokens = r.tokens || [];
    var tb = $('tokRows'); tb.innerHTML = '';
    for (var t of state.tokens) {
      var tr = document.createElement('tr');
      tr.innerHTML = '<td>' + esc(t.name) + '</td>' +
        '<td class="mono">' + esc(t.prefix) + '…</td>' +
        '<td>' + (t.readonly ? '<span class="badge ro">read-only</span>' : '<span class="badge">read-write</span>') + '</td>' +
        '<td class="muted">' + new Date(t.createdAt).toLocaleString() + '</td>' +
        '<td><button class="danger ghost" data-revoke="' + esc(t.id) + '">revoke</button></td>';
      tb.appendChild(tr);
    }
    tb.onclick = async function (ev) {
      var revoke = ev.target.getAttribute && ev.target.getAttribute('data-revoke');
      if (!revoke) return;
      if (!confirm('Revoke this token? Clients using it will stop working.')) return;
      await api('/tokens/' + revoke, { method: 'DELETE' });
      loadTokens();
    };
  }

  async function loadUsage() {
    var box = $('usageBox');
    try {
      var headers = { 'Authorization': 'Bearer ' + (state.activeToken || 'no-token') };
      var res = await fetch('/usage', { headers: headers });
      if (!res.ok) { box.textContent = 'Create a token to see live usage.'; return; }
      var u = await res.json();
      var kb = (u.storage.memoryBytes / 1024).toFixed(1);
      box.innerHTML =
        '<span class="stat"><b>' + u.usage.today + '</b> commands today</span>' +
        '<span class="stat"><b>' + u.storage.keys + '</b> keys</span>' +
        '<span class="stat"><b>' + kb + '</b> KB in memory</span>';
    } catch (e) { box.textContent = e.message; }
  }

  // ── events ────────────────────────────────────────────────────
  $('signupBtn').onclick = async function () {
    $('authMsg').textContent = '';
    try {
      await api('/auth/signup', { method: 'POST', body: { email: $('email').value, password: $('password').value } });
      await refreshMe();
    } catch (e) { $('authMsg').textContent = e.message; }
  };
  $('loginBtn').onclick = async function () {
    $('authMsg').textContent = '';
    try {
      await api('/auth/login', { method: 'POST', body: { email: $('email').value, password: $('password').value } });
      await refreshMe();
    } catch (e) { $('authMsg').textContent = e.message; }
  };
  $('logoutBtn').onclick = async function () {
    await api('/auth/logout', { method: 'POST' });
    state.user = null; showAuth();
  };
  $('createDbBtn').onclick = async function () {
    $('dbMsg').textContent = '';
    try {
      await api('/databases', { method: 'POST', body: { name: $('newDbName').value } });
      $('newDbName').value = '';
      loadDatabases();
    } catch (e) { $('dbMsg').textContent = e.message; }
  };
  $('createTokBtn').onclick = async function () {
    try {
      var r = await api('/databases/' + state.currentDb.id + '/tokens', {
        method: 'POST',
        body: { name: $('tokName').value || 'default', readonly: $('tokReadonly').checked },
      });
      state.activeToken = r.token_plaintext;
      var box = $('newTokenBox');
      box.textContent = r.token_plaintext;
      box.title = 'Copy it now — shown only once';
      show(box);
      $('tokName').value = '';
      loadTokens();
    } catch (e) { log('token error: ' + e.message, '#f85149'); }
  };
  $('runBtn').onclick = async function () {
    var text = $('console').value.trim();
    if (!text) return;
    var cmd;
    try { cmd = JSON.parse(text); } catch (e) { log('> parse error: ' + e.message, '#f85149'); return; }
    var token = state.activeToken;
    if (!token) { log('> create a token first (it is shown once)', '#d29922'); return; }
    try {
      var res = await fetch('/', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify(cmd),
      });
      var data = await res.json();
      log('> ' + JSON.stringify(cmd));
      log(JSON.stringify(data), data.error ? '#f85149' : '#3fb950');
      loadUsage();
    } catch (e) { log('> ' + e.message, '#f85149'); }
  };
  $('password').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') $('loginBtn').click(); });

  refreshMe();
})();
</script>
</body>
</html>`;

const dashboardHtml = html;

module.exports = { dashboardHtml };
