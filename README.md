# Call Center Ops (CCOB)

Internal operations platform for Answering Legal. Provides real-time call center status management, SMS dispatch, agent board, and TV display dashboards.

---

## Stack

| Layer | Technology |
|---|---|
| Backend | Node.js + Express |
| Frontend | Vanilla HTML/CSS/JS (single-file pages, no build step) |
| Persistence | JSON files on disk (`status-store.json`, `tv-sessions.json`) |
| Tunnel (optional) | Cloudflare Tunnel (`cloudflared`) |

---

## Prerequisites

- **Node.js** v18 or higher
- **npm**
- Credentials for all external integrations (see Environment Variables below)

---

## Installation

```bash
git clone <repo-url>
cd callcenter-ops
npm install
cp .env.example .env
# Fill in .env with real credentials (see below)
```

---

## Running

### Production
```bash
npm start
```
Starts the Express server on `PORT` (default `3001`). No file watching.

### Development (server + Cloudflare tunnel)
```bash
npm run dev
```
Starts the server with `--watch` (auto-restarts on file changes) **and** a Cloudflare quick tunnel in parallel. The tunnel URL is printed to the console on startup.

> **Note:** `npm run dev` requires `cloudflared` to be installed at `~/cloudflared`. For production hosting, the tunnel is not needed — use a reverse proxy (nginx, Caddy) or a platform like Railway, Render, or Fly.io instead.

### Tunnel only (without server watch)
```bash
npm run tunnel
```

---

## Environment Variables

Copy `.env.example` to `.env` and fill in all values. The server will not start correctly without the required variables.

### Core

| Variable | Required | Description |
|---|---|---|
| `PORT` | No | Port to listen on. Defaults to `3001`. |
| `DASHBOARD_TOKEN` | **Yes** | Secret token appended to the dashboard URL as `?token=`. Protects the ops dashboard and mobile view from unauthorized access. |
| `API_SECRET_KEY` | **Yes** | Secret key sent as `x-api-key` header from the dashboard to authenticate all write operations. Auto-injected into dashboard/mobile pages at serve time. |

### EZTexting (SMS — US staff)

| Variable | Required | Description |
|---|---|---|
| `EZTEXTING_USERNAME` | **Yes** | EZTexting account email |
| `EZTEXTING_PASSWORD` | **Yes** | EZTexting account password |

### SMS.to (SMS — Belize / Team B)

| Variable | Required | Description |
|---|---|---|
| `SMSTO_API_KEY` | **Yes** | SMS.to Bearer token (from SMS.to dashboard → API Keys) |
| `SMSTO_LIST_ID` | **Yes** | Subscriber list ID to send to (SMS.to → Subscribers → Lists) |

### Bandwidth (DID Counts)

| Variable | Required | Description |
|---|---|---|
| `BANDWIDTH_ACCOUNT_ID` | **Yes** | Bandwidth account ID |
| `BANDWIDTH_API_TOKEN` | **Yes** | OAuth client ID |
| `BANDWIDTH_API_SECRET` | **Yes** | OAuth client secret |
| `BANDWIDTH_SAVVY_SITE_ID` | No | Site ID for Savvy Phone peer (enables per-peer DID count) |
| `BANDWIDTH_SAVVY_PEER_ID` | No | SIP peer ID for Savvy Phone |
| `BANDWIDTH_MITEL_SITE_ID` | No | Site ID for Mitel Classic peer |
| `BANDWIDTH_MITEL_PEER_ID` | No | SIP peer ID for Mitel Classic |

### Monday.com (Agent Board)

| Variable | Required | Description |
|---|---|---|
| `MONDAY_API_KEY` | **Yes** | Monday.com API key (from profile → Developers → My Access Tokens) |
| `MONDAY_BOARD_ID` | **Yes** | ID of the board containing agents (visible in the board URL) |
| `MONDAY_STATUS_COLUMN_ID` | **Yes** | Column ID for agent status (e.g. `status`) |
| `MONDAY_CALLCENTER_COLUMN_ID` | **Yes** | Column ID for call center assignment (e.g. `color_mkvtbm60`) |
| `MONDAY_HERE_LABEL` | No | Status label meaning "agent is present". Default: `Here` |
| `MONDAY_STANDBY_LABEL` | No | Status label for standby. Default: `On Standby` |

### Wix (Public Status Page — optional)

| Variable | Required | Description |
|---|---|---|
| `WIX_SITE_ID` | No | Wix site UUID |
| `WIX_API_KEY` | No | Wix API key (from Wix dashboard → Settings → API Keys) |
| `WIX_ACCOUNT_ID` | No | Wix account UUID (optional, improves auth) |
| `WIX_COLLECTION_NAME` | No | Wix CMS collection name. Default: `SystemStatus` |

### Slack (Notifications — optional)

Slack webhook URLs are configured in the dashboard UI (Settings → Slack Workflows) and stored in browser localStorage — they are **not** needed in `.env`.

---

## File Structure

```
callcenter-ops/
├── server.js                  # Express backend — all API routes
├── package.json
├── .env                       # Credentials (never commit)
├── .env.example               # Template
├── status-store.json          # Persisted call center status (auto-created)
├── tv-sessions.json           # TV display session tokens (auto-created)
└── public/
    ├── al-logo.png            # Answering Legal logo
    ├── down-image.png         # Image shown on call center DOWN event
    ├── CCOB_Dashboard.html    # Main ops dashboard (protected)
    ├── CCOB_Mobile.html       # Mobile ops dashboard (protected)
    ├── CCOB_TV_Display.html   # Dialed In Dash — TV display (session-gated)
    ├── CCOB_TV_Pulse.html     # Dialed In Dash Pulse — simplified TV display (public)
    ├── CCOB_Widget.html       # Embeddable status widget (public)
    └── CCOB_Status_Widget.html
```

---

## Routes & Access Control

### Protected Pages (require `?token=DASHBOARD_TOKEN`)

| URL | Description |
|---|---|
| `/dashboard?token=<DASHBOARD_TOKEN>` | Full ops dashboard |
| `/mobile?token=<DASHBOARD_TOKEN>` | Mobile ops dashboard |

The `API_SECRET_KEY` is automatically injected into these pages at serve time so users don't need to enter it manually.

### Session-Gated Pages (require TV session token)

| URL | Description |
|---|---|
| `/dialed-in?t=<session-token>` | Dialed In Dash (TV display). Session token generated by the dashboard on open. Valid 24 hours. |

### Public Pages

| URL | Description |
|---|---|
| `/CCOB_TV_Pulse.html` | Dialed In Dash Pulse (simplified 4-panel display, no token required) |
| `/CCOB_Widget.html?cc=<key>&key=<apiKey>&backend=<url>` | Embeddable status widget |

### API Endpoints

All write endpoints require `x-api-key: <API_SECRET_KEY>` header.

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/status` | None | Current status for all systems |
| `POST` | `/api/status` | API key | Update status for any/all systems |
| `GET` | `/api/bandwidth/dids` | None | DID counts from Bandwidth |
| `GET` | `/api/monday/agents` | None | Agent list from Monday.com |
| `POST` | `/api/monday/agent/:id/standby` | API key | Move agent to Standby |
| `POST` | `/api/monday/agent/:id/here` | API key | Move agent to Here |
| `GET` | `/api/eztexting/groups` | API key | All EZTexting groups (paginated) |
| `POST` | `/api/eztexting/send` | API key | Send SMS via EZTexting |
| `POST` | `/api/smsto/send` | API key | Send SMS via SMS.to (Belize list) |
| `POST` | `/api/slack/notify` | API key | Fire a Slack webhook |
| `POST` | `/api/tv-session` | API key | Generate a TV session token |
| `POST` | `/api/wix/status` | API key | Push status to Wix CMS |
| `GET` | `/api/wix/status` | API key | Read status from Wix CMS |
| `GET` | `/health` | API key | Health check |

---

## Persistence

Two JSON files are written to the project root at runtime. They do not need to exist before first run — the server creates them automatically with defaults.

| File | Purpose |
|---|---|
| `status-store.json` | Current state of all call centers, DID status, and systems message. Survives server restarts. |
| `tv-sessions.json` | Active TV display session tokens. Expired tokens are pruned hourly. |

**For hosted deployments:** ensure the process has write access to the project root, or mount a persistent volume at that path (important for platforms like Railway or Fly.io that use ephemeral filesystems).

---

## Hosting Recommendations

The backend is a plain Node/Express app with no database dependency. Any platform that runs Node.js works.

### Recommended: Railway / Render / Fly.io
- Set all environment variables in the platform dashboard
- Set start command to `npm start`
- Ensure a persistent disk/volume is mounted at the app root for `status-store.json` and `tv-sessions.json`, or replace file persistence with a database (Redis or SQLite recommended)
- The app listens on `process.env.PORT` — most platforms set this automatically

### Self-hosted (VPS / EC2)
```bash
npm install -g pm2
pm2 start server.js --name ccob
pm2 save
```
Use nginx or Caddy as a reverse proxy to handle HTTPS and forward to port 3001.

### Cloudflare Tunnel (current dev setup)
`npm run dev` starts a quick tunnel automatically. For a permanent tunnel tied to a domain:
```bash
cloudflared tunnel login
cloudflared tunnel create ccob
cloudflared tunnel route dns ccob ops.yourdomain.com
cloudflared tunnel run --url http://localhost:3001 ccob
```

---

## First-Time Setup Checklist

- [ ] `npm install`
- [ ] Copy `.env.example` → `.env`, fill in all credentials
- [ ] `npm start`
- [ ] Open `http://localhost:3001/dashboard?token=<DASHBOARD_TOKEN>`
- [ ] Go to **Settings → API Keys** — verify backend connection test passes
- [ ] Go to **Status Board** — confirm status loads and toggles sync
- [ ] Go to **SMS** — click ↻ Refresh Groups and confirm EZTexting groups load
- [ ] Go to **Agent Board** — confirm Monday.com agents appear
- [ ] Open **Dialed In Dash** from the nav — confirm TV display loads and polls status
- [ ] Open `http://localhost:3001/CCOB_TV_Pulse.html` — confirm Pulse display loads
- [ ] Open `http://localhost:3001/mobile?token=<DASHBOARD_TOKEN>` — confirm mobile view works
