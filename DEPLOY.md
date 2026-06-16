# Deploying to Render (free, always-on)

This app is read-only and holds **no private keys**, so it's safe to host publicly.
Render's free tier gives you a free `*.onrender.com` URL — no domain or hosting cost.

## One-time setup

### 1. Put the code on GitHub (free)

Create an empty repo at https://github.com/new (e.g. `rh-token-explorer`, public is fine).
Then, in `Z:\rh-token-explorer`:

```powershell
git init
git add .
git commit -m "Robinhood L2 token explorer"
git branch -M main
git remote add origin https://github.com/<your-username>/rh-token-explorer.git
git push -u origin main
```

(The local repo is already initialized and committed for you — you only need the
last three lines: `remote add`, `branch -M main`, and `push`.)

### 2. Create the Render service (free)

1. Sign up at https://render.com (log in with GitHub — free).
2. Click **New → Web Service**.
3. Connect your GitHub and pick the `rh-token-explorer` repo.
4. Render detects `render.yaml` automatically. If it asks, confirm:
   - **Runtime:** Node
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Instance type:** Free
5. Click **Create Web Service**.

After ~1–2 minutes you'll get a public URL like
`https://rh-token-explorer.onrender.com` — share it with anyone.

## Updating the site later

Just push to GitHub — Render redeploys automatically:

```powershell
git add .
git commit -m "update"
git push
```

## Good to know (free tier)

- **Cold start:** the free instance sleeps after ~15 min of no traffic. The first
  visit after sleeping takes ~30–50 s to wake up, then it's fast again.
- **Shared public RPC:** every visitor's lookup scans chain logs via the public RPC
  (`poptye-always-win.poptyedev.com`). Under heavy traffic that RPC may rate-limit.
  If it becomes a problem, point `RPC_URL` (in the Render dashboard → Environment) at
  a dedicated RPC endpoint.
- **No secrets:** this project has no `.env` with keys. The optional `ETH_USD` can be
  set in the Render dashboard if the Coinbase price feed is ever blocked.

## ⚠️ Do NOT deploy the bridge bot

Only deploy **this** project (`rh-token-explorer`). The other project
(`relay-bridge-bot`) contains a **private key** in its `.env` and must never be pushed
to GitHub or any host.
