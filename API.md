# Callcenter Ops API

External-facing API reference for the dev team. All endpoints below are read-only (`GET`). Mutations are restricted to the internal dashboard.

**Base URL:** `https://ops.answeringlegal.com`

---

## Authentication

Most endpoints require an API key, passed as a header:

```
X-API-Key: <your-key>
```

Get the key from your ops admin (stored as `DEV_API_KEY` server-side).

**Errors:**
- `401 Unauthorized` — key missing, wrong, or used on a non-GET request
- `403 Forbidden` — endpoint requires an admin session (the API key doesn't grant role-based access)

### Public endpoints (no key needed)

The `/api/widget/*` namespace is intentionally open — these are what the public Wix site embed uses. The payloads are stripped down (no employee names or internal flags).

---

## Quick example

```bash
KEY="<your-api-key>"

# Is the Mitel system up?
curl -s -H "X-API-Key: $KEY" \
  https://ops.answeringlegal.com/api/status \
  | jq '.mitelClassic.state'
# → "UP"  or  "DOWN"
```

---

## Endpoints

### `GET /api/widget/status`  *(public, no key)*

The sanitized status payload used by the Wix embed. Use this if you only need up/down and don't want to manage a key.

```json
{
  "mitelClassic": { "state": "UP",   "message": "" },
  "savvyPhone":   { "state": "UP",   "message": "" },
  "updatedAt":    "2026-06-29T18:32:14.221Z"
}
```

- `state` — `"UP"` (operational) or `"DOWN"` (standby)
- `message` — optional user-facing context shown alongside the dot

### `GET /api/widget/sms-history?limit=50`  *(public, no key)*

Recent staff broadcast SMS, stripped of recipient phone numbers and sender identity.

```json
[
  { "message": "Mitel is on standby...", "sentAt": "2026-06-29T17:10:00Z", "groups": ["agents"] }
]
```

### `GET /api/widget/staff-broadcast`  *(public, no key)*

Currently-active staff broadcast banner, with the author's name stripped.

```json
{ "title": "...", "body": "...", "imageUrl": "", "links": [], "updatedAt": "..." }
```
Returns `{ "empty": true }` if no broadcast is active.

---

### `GET /api/status`  *(key required)*

Full system status — every dashboard system, including audit fields (who toggled it, when).

```json
{
  "savvyPhone":     { "state": "UP", "didCount": null, "message": "", "changedBy": "...", "changedAt": "..." },
  "mitelClassic":   { "state": "UP", "didCount": null, "message": "", "changedBy": "...", "changedAt": "..." },
  "mobileApp":      { "state": "UP", "messagesDown": false, "message": "", "changedBy": "...", "changedAt": "..." },
  "integrations":   { "state": "UP", "messagesDown": false, "message": "", "changedBy": "...", "changedAt": "..." },
  "didStatus":      "UP",
  "systemsMessage": "",
  "publicState":    "operational",
  "updatedAt":      "2026-06-29T18:32:14.221Z"
}
```

### `GET /api/mitel/queue-stats`  *(key required)*

Live queue stats from the office Mitel SQL server. Updated every 5 seconds by the on-prem poller; served from in-memory cache.

```json
{
  "queues": [
    {
      "id":             "P862",
      "name":           "8262",
      "answered":       142,
      "abandoned":      11,
      "avgWait":        18,
      "avgDuration":    243,
      "recentAnswered": 6,
      "recentAvgWait":  12,
      "recentMaxWait":  41
    }
  ],
  "hourlyStats": [
    { "label": "10 AM", "avgWait": 16, "answered": 48 }
  ],
  "updatedAt": "2026-06-29T18:32:14.221Z"
}
```

- `queues[*].id` — Mitel queue ID (`P862`, `P861`, `P803`)
- `queues[*].name` — extension number (e.g. `8262`)
- `avgWait`, `recentAvgWait`, `recentMaxWait`, `avgDuration` — seconds
- `hourlyStats` — the previous three EST hours

Returns `{ "unconfigured": true }` if the poller isn't running.
Returns `503` if no data has been pushed yet.

### `GET /api/mitel/queue-stats/stream`  *(key required)*

Server-sent events stream of the same data. Push happens within ~5s of new poller data. Heartbeats every 25s.

```bash
curl -N -H "X-API-Key: $KEY" https://ops.answeringlegal.com/api/mitel/queue-stats/stream
```

### `GET /api/mitel/cloudlink/calls`  *(key required)*

Active calls pulled from the Mitel CloudLink REST API.

---

### `GET /api/bandwidth/dids`  *(key required)*

DID counts per Bandwidth site (Savvy + Mitel).

### `GET /api/hubspot/dids`  *(key required)*

DID pool counts (available + instant-AL + instant-RS) sourced from HubSpot deal pipeline stages. Cached server-side.

```json
{ "didPool": 42, "instantDidPool": 7, "syncedAt": "2026-06-29T18:32:14.221Z" }
```

---

### Monday.com

| Endpoint | Description |
|---|---|
| `GET /api/monday/agents` | Agent roster + here/standby status |
| `GET /api/monday/support-tasks` | Active support tasks (open + upcoming + completed today) |
| `GET /api/monday/support-stats` | Aggregated counts for the support TV dashboard |
| `GET /api/monday/account-review` | Recent account review items (top 500 most recently updated) |

### Zendesk

| Endpoint | Description |
|---|---|
| `GET /api/zendesk/queue-stats?team=tech\|support` | Current ticket queue counts by status |
| `GET /api/zendesk/stale-tickets?team=tech\|support&hours=24` | Tickets older than N business hours |
| `GET /api/zendesk/csat?team=tech\|support&period=today\|this-week\|this-month` | CSAT good/bad counts |
| `GET /api/zendesk/leaderboard?team=tech\|support&period=today\|this-week` | Agent leaderboard (solved + CSAT + section breakdown) |

### Xcally

| Endpoint | Description |
|---|---|
| `GET /api/xcally/queue` | Live state of the configured Xcally voice queue |

---

## Notes & gotchas

- **GET only.** The API key is rejected on `POST`/`PUT`/`DELETE`/`PATCH`. Mutations require a Google-authenticated session through the dashboard.
- **Rate limits.** None enforced today. Be reasonable; the Mitel and Zendesk endpoints hit upstream APIs.
- **Caching.** `/api/hubspot/dids` and the Zendesk leaderboard are cached server-side (a few seconds to a minute). Don't expect sub-second freshness.
- **Mitel queue stats** depend on the on-prem SQL poller. If the office PC running the poller is offline, the endpoint returns `503` after ~90s.
- **Time zones.** All timestamps are ISO 8601 UTC. Mitel `hourlyStats[*].label` is rendered in `America/New_York` (e.g. `"10 AM"`).
- **Rotating the key.** Update `DEV_API_KEY` in `/opt/ccops/.env` and run `pm2 restart ccops --update-env`. There's no key-revocation list — rotating invalidates the old key for everyone.
