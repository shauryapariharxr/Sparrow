# Deploying Sparrow — Vercel (frontend) + Render (backend)

The repo is split into two deployable halves:

```
frontend/   →  Vercel   (static pages + vercel.json proxy rules)
backend/    →  Render   (Node API + engine, needs a persistent disk)
```

The browser only ever talks to the Vercel domain. `frontend/vercel.json` rewrites every
API path to the Render service, so pages, cookies and API calls stay same-origin —
no CORS and no cookie changes anywhere.

## 1. Backend on Render

1. Render dashboard → **New → Web Service** → connect this GitHub repo.
2. Settings:
   - **Root Directory:** leave blank (Render runs from repo root)
   - **Build Command:** `npm ci` (or `npm install`)
   - **Start Command:** `node backend/index.js`
   - **Instance type:** Starter — the free tier has no persistent disk, so data
     would vanish on every restart
3. **Disks → Add disk**
   - Name: `sparrow-data`
   - Mount path: `/data`
   - Size: 1 GB to start
4. **Environment variables:**
   ```
   REDEX_DATA_DIR=/data/engine
   REDEX_SQLITE_PATH=/data/control.db
   REDEX_RESP_PORT=0
   ```
   Do **not** set `REDEX_HOST` or `REDEX_PORT` — Render injects `PORT` and the
   backend picks it up automatically.
5. **Health check path:** `/healthz`
6. Deploy, then verify: `curl https://<your-service>.onrender.com/healthz`

## 2. Frontend on Vercel

1. Vercel dashboard → **Add New → Project** → import the same GitHub repo.
2. Configure:
   - **Root Directory:** `frontend`
   - Framework Preset: **Other** (it's plain static files — zero build)
3. Deploy. `frontend/vercel.json` handles everything:
   - `index.html`, `auth.html`, `dashboard.html` are served statically
   - `/login`, `/signup`, `/dashboard` map to the right pages
   - `/pipeline`, `/auth/*`, `/databases/*`, `/tokens/*`, `/usage/*`,
     `/storage/*`, `/subscribe/*`, `/healthz` and the path-style
     `/:cmd/:path*` commands proxy to Render

## 3. Point the proxy at your Render URL

`frontend/vercel.json` currently proxies to a hardcoded Render URL. After step 1
gives you the real one, replace every occurrence:

```
https://sparrow-ixbb.onrender.com  →  https://<your-service>.onrender.com
```

Commit and push — Vercel redeploys automatically.

To change the URL without touching code, you can instead set a Vercel environment
variable and use it in rewrites (Vercel supports `:env` style env interpolation in
`vercel.json` destinations).

## 4. Verify the whole chain

```bash
# 1. Vercel serves the landing page
curl -s https://<your-app>.vercel.app/ | head -5

# 2. Proxy reaches the backend
curl -s https://<your-app>.vercel.app/healthz

# 3. Sign up in the dashboard, create a database, mint a token, then:
curl -X POST https://<your-app>.vercel.app/set/hello/world \
  -H "Authorization: Bearer sparrow_YOUR_TOKEN"

curl https://<your-app>.vercel.app/get/hello \
  -H "Authorization: Bearer sparrow_YOUR_TOKEN"
```

Then the persistence check: Render → Manual Deploy → after restart the `GET`
must still return `world` (proves the disk is mounted).

## Architecture notes

- **Session cookies just work.** The dashboard authenticates with an `HttpOnly`,
  `SameSite=Lax` cookie. Because Vercel proxies the API paths, the browser sees
  everything as one origin — the cookie is set and sent on the Vercel domain
  without any special handling.
- **`POST /pipeline`** is the single command endpoint for both single commands
  (`["SET","k","v"]`) and batches (array of arrays). The dashboard and landing
  quickstart already use it.
- **The backend can still serve the frontend standalone** (local dev, or the
  Render-only setup) — `backend/web/server.js` reads the pages from `../frontend`.
  Locally: `npm start` → everything on one port as before.
- **Only one backend instance.** The engine is in-memory + SQLite single-writer;
  never scale Render beyond 1 instance.
