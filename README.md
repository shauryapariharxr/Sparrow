# Redex

**Redis-as-a-Service, Upstash-style** — a multi-tenant, HTTP-accessible Redis-compatible data store. Users sign up, create a *database*, and get a REST endpoint + API token. Every Redis command is a plain HTTPS call: no client library, no persistent connection — a single `fetch()` or `curl` works, which makes it usable from serverless and edge runtimes.

Built with **zero runtime dependencies** on Node.js ≥ 22.5 (uses the built-in `node:sqlite` for the control plane).

```
Client (fetch / curl / SDK)
        │  HTTPS + Bearer token
        ▼
┌──────────────────────┐
│   REST API Gateway   │  auth · rate limit · routing · JSON ⇄ replies
└──────────┬───────────┘
           │  in-process command dispatch (or RESP on loopback)
           ▼
┌──────────────────────┐
│  Redis Core Engine   │  per-tenant keyspace: strings · lists · sets ·
│ (hand-built clone)   │  zsets · hashes · expiry · quotas · pub/sub
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│  Persistence Layer   │  per-tenant AOF + RDB snapshots
└──────────────────────┘

Control plane (same process, separate SQLite + routes)
┌─────────────────────────────────────────────┐
│ Auth · Users · Sessions · Databases ·       │
│ Tokens · Usage metering · Dashboard SPA     │
└─────────────────────────────────────────────┘
```

## Quickstart

```bash
npm start
# → gateway on http://127.0.0.1:8080
# → dashboard at http://127.0.0.1:8080/dashboard
# → RESP debug server on redis://127.0.0.1:6379 (loopback only)
```

Provision and use a database with the CLI:

```bash
node bin/redex.js signup --email me@example.com --password secret123
node bin/redex.js create --email me@example.com --password secret123 --name mydb
# → prints the API token (shown only once)

TOK=redex_...
node bin/redex.js call --db db_x --token $TOK SET hello world
node bin/redex.js call --db x --token $TOK '["GET","hello"]'
node bin/redex.js pipe  --db x --token $TOK '[["INCR","c"],["INCR","c"]]'
node bin/redex.js sub   --db x --token $TOK mychannel
```

Or drive everything from raw HTTP:

```bash
# sign up, create a database, mint a token via the control-plane routes
curl -X POST localhost:8080/auth/signup -d '{"email":"me@x.com","password":"secret123"}' -H 'Content-Type: application/json' -c jar
curl -X POST localhost:8080/databases -d '{"name":"mydb"}' -H 'Content-Type: application/json' -b jar
curl -X POST localhost:8080/databases/<dbId>/tokens -d '{}' -H 'Content-Type: application/json' -b jar
```

## REST API (data plane)

All data-plane requests need `Authorization: Bearer redex_...`.

**Path style** — command name and args in the URL:

```bash
curl -X POST https://host/set/mykey/myvalue -H "Authorization: Bearer $TOK"
curl -X POST https://host/get/mykey         -H "Authorization: Bearer $TOK"
```

**JSON style** — one command per request:

```bash
curl -X POST https://host/ -H "Authorization: Bearer $TOK" \
     -d '["SET","mykey","myvalue","EX","60"]'
```

**Pipeline** — many commands, one round trip (atomicity: none, like Upstash pipeline; responses come back in order):

```bash
curl -X POST https://host/pipeline -H "Authorization: Bearer $TOK" \
     -d '{"commands":[["SET","k","1"],["INCR","k"],["GET","k"]]}'
# → [{"result":"OK"},{"result":2},{"result":"2"}]
```

**Subscribe** — Server-Sent Events:

```bash
curl -N https://host/subscribe/mychannel -H "Authorization: Bearer $TOK"
# event: ready
# data: {"channel":"mychannel"}
# event: message
# data: {"channel":"mychannel","message":"hello"}
```

**Usage** — commands/day and storage stats for the token's database:

```bash
curl https://host/usage -H "Authorization: Bearer $TOK"
```

Response conventions: success → `{"result": ...}`, error → `{"error":"..."}` with HTTP 400/401/403/413/429. Nulls are `{"result":null}`. Binary values are escaped as `\xNN`.

### Supported commands

| Group | Commands |
|---|---|
| Strings | `GET SET SETEX PSETEX SETNX GETSET GETDEL APPEND STRLEN GETRANGE SETRANGE INCR DECR INCRBY DECRBY INCRBYFLOAT MGET MSET MSETNX` |
| Keyspace | `DEL UNLINK EXISTS TYPE KEYS SCAN RANDOMKEY RENAME RENAMENX COPY DBSIZE FLUSHDB FLUSHALL` |
| Expiry | `TTL PTTL EXPIRE PEXPIRE EXPIREAT PEXPIREAT PERSIST` (incl. `NX/XX/GT/LT` flags) |
| Lists | `LPUSH RPUSH LPUSHX RPUSHX LPOP RPOP LLEN LINDEX LSET LINSERT LREM LRANGE LTRIM LMOVE RPOPLPUSH` |
| Sets | `SADD SREM SISMEMBER SMISMEMBER SCARD SMEMBERS SPOP SRANDMEMBER SUNION SUNIONSTORE SINTER SINTERSTORE SDIFF SDIFFSTORE` |
| Sorted sets | `ZADD (NX/XX/GT/LT/CH/INCR) ZSCORE ZMSCORE ZINCRBY ZCARD ZCOUNT ZRANGE (REV/BYSCORE/BYLEX/LIMIT) ZRANGEBYSCORE ZREVRANGEBYSCORE ZREVRANGE ZRANGEBYLEX ZREVRANGEBYLEX ZRANK ZREVRANK ZREM ZPOPMIN ZPOPMAX ZUNIONSTORE ZINTERSTORE` |
| Hashes | `HSET HSETNX HGET HMGET HGETALL HEXISTS HKEYS HVALS HLEN HSTRLEN HDEL HINCRBY HINCRBYFLOAT` |
| Server / pubsub | `PING ECHO TIME SELECT PUBLISH` |

## Architecture notes

**Multi-tenancy.** Each database gets an isolated `Keyspace` instance in the shared engine (per-tenant `Map`, stats, memory accounting, pub/sub hub) rather than key-prefix mangling — a tenant's keys are physically unreachable from another tenant's command path. The namespace is always derived from the authenticated token; nothing the client sends can select a keyspace.

**Persistence.** Per-tenant `data/engine/<dbId>/appendonly.aof` (JSON-lines, fsync `always`) plus atomic snapshots (`snapshot.rdb`, tmp+rename). Snapshots carry an AOF sequence marker so reload replays only the tail after the snapshot — no double-application. Compaction rewrites snapshot + truncates AOF. A background cycle sweeps expirations, snapshots dirty tenants, and unloads idle tenants.

**Auth & tokens.** API tokens are `redex_` + 43 base62 chars (~256 bits), stored only as SHA-256 hashes; a 10 s in-memory hash→tenant cache fronts the SQLite lookup. Read-only tokens are enforced per command against a read-command allowlist. Dashboard sessions are opaque `sess_` tokens in HttpOnly cookies; passwords are scrypt-hashed.

**Quotas & limits.** Per-database `maxKeys`, `maxMemoryBytes` (approximate, incrementally tracked per value), `maxValueBytes`; per-token token-bucket rate limiting with burst and `X-RateLimit-*` headers; per-request payload cap; pipeline cost scales with command count.

**RESP debug server.** A loopback-only RESP2 listener (`REDEX_RESP_PORT`, default 6379) lets you poke a tenant with redis-cli via `AUTH <api-token>`. It is a debug convenience — the REST gateway is the production path.

## Configuration

Every knob has a default; see `.env.example`. Key ones:

| Variable | Default | Meaning |
|---|---|---|
| `REDEX_HOST` / `REDEX_PORT` | `127.0.0.1` / `8080` | Gateway bind address |
| `REDEX_SQLITE_PATH` | `./data/control.db` | Control-plane database |
| `REDEX_DATA_DIR` | `./data/engine` | Per-tenant AOF/RDB root |
| `REDEX_AOF_FSYNC` | `always` | `always` \| `everysec` \| `no` |
| `REDEX_MAX_KEYS` / `REDEX_MAX_MEMORY_BYTES` / `REDEX_MAX_VALUE_BYTES` | `100000` / `128MiB` / `1MiB` | Per-database quotas |
| `REDEX_RL_CAPACITY` / `REDEX_RL_REFILL_PER_SEC` / `REDEX_RL_MAX_BURST` | `200` / `100` / `400` | Rate limiting |
| `REDEX_RESP_PORT` | `6379` | `0` disables the RESP debug listener |

In production, put Nginx/Caddy in front for TLS termination and set `REDEX_HOST` to a private interface.

## Project layout

```
src/
  index.js                 entrypoint: wires everything, graceful shutdown
  config.js                env-driven configuration
  util.js                  ids, tokens, hashing, HTTP helpers
  engine/
    store.js               Keyspace: map, expiry index, memory accounting
    engine.js              per-tenant Engine + command dispatch
    commands_core.js       strings, keyspace, expiry, server commands
    commands_collections.js lists, sets, zsets, hashes
    cmdutil.js / zsetutil.js  parsing, glob, score/lex ranges
    persistence.js         AOF + RDB per tenant
    pubsub.js              channel hub (PUBLISH + SSE fanout)
    resp.js / respServer.js  RESP codec + loopback debug server
    tenantManager.js       tenant registry, background cycles
  control/
    store.js               SQLite schema + queries
    service.js             signup/login, databases, tokens, usage
  gateway/
    index.js               HTTP surface (data + control plane)
    rateLimiter.js         token buckets
    serialization.js       replies → JSON
  dashboard/
    index.js               single-file dashboard SPA
test/                      node:test suites (engine, persistence, gateway)
bin/redex.js               CLI
scripts/e2e-live.js        live end-to-end check against a running server
```

## Tests

```bash
npm test          # 44 tests: engine semantics, persistence, gateway e2e
node scripts/e2e-live.js   # against a running server (BASE=http://127.0.0.1:8090)
```

## Roadmap beyond v1

Per the design's non-goals, deliberately out of scope for now: native TCP for external users, multi-region replication, horizontal sharding, billing. Natural next steps: WebSocket subscribe, Lua scripting (`EVAL`), sorted-set `ZUNION`/`ZINTER` (non-store), stream type, per-tenant engine processes for hard isolation at higher tiers.
"# Sparrow" 
