# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development (runs server + Vite dev server + Cloudflare tunnel concurrently)
npm run dev

# Build React client to /public/app (run before committing UI changes)
npm run build

# Production server only
npm start

# Lint client code
cd client && npm run lint
```

## Deploy to Production

The production server is a DigitalOcean VPS at `165.22.11.251` running PM2. After pushing to GitHub:

```bash
ssh root@165.22.11.251 "cd /opt/ccops && git pull origin main && pm2 restart ccops"
```

No build step needed on the server — compiled assets in `public/app/` are committed to the repo and served as static files. `ops.answeringlegal.com` points directly to this VPS.

## Architecture

**Single-file backend:** All ~1800 lines of Express routes, middleware, polling, and persistence live in `server.js`. Auth helpers are in `auth.js`.

**Frontend:** React SPA in `client/src/`, built by Vite to `public/app/`. In dev, Vite runs on port 5173 and proxies `/api` to the Express server on port 3001. In production, Express serves the compiled build directly.

**Auth:** Google OAuth 2.0 via Passport.js with session cookies (8-hour expiry). In dev mode (`NODE_ENV !== 'production'` with no `GOOGLE_CLIENT_ID`), all routes auto-authenticate as `super_admin`. Roles: `super_admin`, `call_center_ops`, `support`, `tech`, `tv_display`.

**API client:** `client/src/api.js` exports a pre-configured Axios instance with `withCredentials: true` and a 401 interceptor that redirects to `/login`. Always import `api` from there, not raw axios.

**Shared state:** `AuthContext` handles session state. `AppContext` handles status polling (every 15s), DID counts, toasts, and dark mode. Both wrap the entire app.

**Persistence:** No database. Two JSON files auto-created at runtime:
- `status-store.json` — system UP/DOWN states, survives restarts
- `tv-sessions.json` — 24-hour TV display session tokens, pruned hourly

## Key Patterns

**Monday.com GraphQL:** All board queries use cursor-based pagination — first request goes to `boards(ids:[...]) { items_page(limit:200) { cursor items {...} } }`, subsequent pages use `next_items_page(limit:200, cursor:"...")`. Always check `response.data?.errors` for GraphQL-level errors. Column IDs are hardcoded per board (e.g. `color_mkxwxqsx` = Task Status, `multiple_person_mm38yn50` = Working person on the support task board `18358060875`).

**Mitel queue stats:** A background `pollMitelQueues()` runs every 5s server-side, fetching from JSONBin and caching in memory. Real-time updates are pushed to clients via SSE at `/api/mitel/queue-stats/stream`. Token-gated via `?t=<session-token>` query param.

**TV display access:** TV pages (`/support-dash`, `/tech-dash`) are accessible without login via a 24-hour session token (`?t=<token>`). Generate tokens via `POST /api/tv-session` (requires auth). Validate via `GET /api/tv-session/validate?t=<token>`.

**Time zones:** Monday.com date column `text` field returns dates in workspace timezone (EST), e.g. `"2026-05-13 12:00"`. The `value` field's `time` property is UTC. Always use `text` for display (parse the `HH:MM` after the space), not `raw.time`.

**dueTime formatting:** A `fmt12hr(timeStr)` helper exists in `SupportCenter.jsx`, `TechCenter.jsx`, and `SupportTVPage.jsx` — converts `"HH:MM"` to `"H:MM AM/PM"`.

## Environment Variables

See `.env.example` for all required vars. Key ones:
- `MONDAY_API_KEY`, `MONDAY_BOARD_ID` — agents board; `MONDAY_SUPPORT_TASK_BOARD_ID` — support tasks
- `BANDWIDTH_*` — DID counts via OAuth2 against `api.bandwidth.com`
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_CALLBACK_URL` — OAuth; omit for dev auto-login
- `SESSION_SECRET` — change in production
- `ZENDESK_SUBDOMAIN` / `ZENDESK_EMAIL` / `ZENDESK_API_TOKEN` — ticket queue and leaderboard
- `HUBSPOT_PRIVATE_APP_TOKEN` — DID pool counts
