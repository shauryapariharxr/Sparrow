# Deploying Sparrow

Single Node process, zero runtime dependencies. Everything below deploys the same image (`deploy/Dockerfile`); the only non-negotiables are:

1. **A persistent disk** for `/data` — it holds the control-plane SQLite DB (users, tokens) and every tenant's AOF/RDB files. Without it, all data vanishes on restart.
2. **`REDEX_RESP_PORT=0`** — the RESP debug TCP server stays off in production.
3. **One instance** — the in-memory engine + SQLite are single-writer; never scale horizontally.

---

## Render (manual, no blueprint)

Render can deploy the existing `deploy/Dockerfile` directly:

1. Push the repo to GitHub, then Render dashboard → **New → Web Service** → connect the repo.
2. Runtime: **Docker** (it auto-detects `deploy/Dockerfile`; set Dockerfile path to `./deploy/Dockerfile` if asked).
3. Instance type: **Starter or above** — persistent disks require a paid plan (the free tier has no disk, so data resets on restart).
4. **Advanced → Add Disk**: mount path `/data`, 1 GB.
5. Environment variables: `REDEX_DATA_DIR=/data/engine`, `REDEX_SQLITE_PATH=/data/control.db`, `REDEX_RESP_PORT=0`.
6. Health check path: `/healthz`. Deploy — you get `https://<service>.onrender.com` with TLS.

Keep instances at 1, and note Render disks are not backed up automatically — snapshot `/data` periodically if this holds real data.

---

## Railway

Uses `railway.json` + `railway.toml` (deploys `deploy/Dockerfile`):

```bash
npm i -g @railway/cli && railway login
railway init && railway up
```

Then in the dashboard: **attach a Volume mounted at `/data`** and **add a public domain**. `railway.toml` already sets `REDEX_DATA_DIR`/`REDEX_SQLITE_PATH` to `/data/…` and `REDEX_RESP_PORT=0`. Keep `numReplicas: 1`.

---

## VPS (recommended for production: cheapest, full control)

Node ≥ 22.5, then:

```bash
# 1. Service user + data dir
sudo useradd -r -s /usr/sbin/nologin sparrow
sudo mkdir -p /var/lib/sparrow && sudo chown sparrow:sparrow /var/lib/sparrow

# 2. App
sudo git clone <your-repo> /opt/sparrow && cd /opt/sparrow && npm test
sudo cp deploy/sparrow.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now sparrow
curl http://127.0.0.1:8080/healthz   # {"ok":true}

# 3. HTTPS in one file (Caddy auto-provisions + renews certificates)
sudo apt-get install -y caddy
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile   # edit your-domain.com first
sudo systemctl reload caddy
```

Point an A record at the server. Update procedure: `cd /opt/sparrow && git pull && sudo systemctl restart sparrow` — data survives (AOF replay + snapshot).

---

## Docker anywhere

```bash
docker build -t sparrow -f deploy/Dockerfile .
docker run -d --name sparrow \
  -p 127.0.0.1:8080:8080 \
  -v sparrow-data:/data \
  -e REDEX_DATA_DIR=/data/engine \
  -e REDEX_SQLITE_PATH=/data/control.db \
  -e REDEX_RESP_PORT=0 \
  --restart unless-stopped \
  sparrow
```

Fly.io and Render also accept this Dockerfile directly (new app → deploy from Dockerfile → attach a volume/disk at `/data`).

---

## Environment variables (production-relevant)

| Variable | Default | Notes |
|---|---|---|
| `REDEX_PORT` | `8080` | HTTP API + dashboard port (bind `0.0.0.0` behind a proxy) |
| `REDEX_DATA_DIR` | `./data/engine` | Tenant AOF/RDB + engine DB — **put on the persistent disk** |
| `REDEX_SQLITE_PATH` | `./data/control.db` | Users, tokens, sessions — **put on the persistent disk** |
| `REDEX_RESP_PORT` | `6379` | RESP debug server; **set `0` in production** |
| `REDEX_AOF_FSYNC` | `always` | `everysec` trades a little durability for throughput |
| `REDEX_MAX_MEMORY_BYTES` | `134217728` | Per-tenant memory quota |

---

## Security checklist

- [ ] HTTPS only (Caddy/Render/Railway all terminate TLS for you)
- [ ] `REDEX_RESP_PORT=0` (RESP debug port off)
- [ ] Data directory (`/data`) on a backup schedule
- [ ] App binds loopback when behind a local proxy (VPS path)
- [ ] `numInstances`/`numReplicas` = 1 everywhere
