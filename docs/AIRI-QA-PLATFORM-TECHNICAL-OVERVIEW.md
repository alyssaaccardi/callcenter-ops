# AIRI QA Platform — Technical Overview

Audience: the dev team. Purpose: explain what the system does, how it is built, how it is secured today, which API endpoints exist, and which protections still need to be added.

Everything below was taken from the code (`server.js`, `auth.js`, `ai-bot-qc/*`, `client/src/modules/AiBotQc.jsx`). Items marked **GAP** are things that are not in place today.

---

## 1. What it does

AIRI is the AI phone-answering bot. This platform lets QA Agents review the bot's recorded calls and lets admins/Hitsquad act on problems.

| Capability | Summary |
|---|---|
| Review queue | Every bot call is indexed from the recording archive. QA Agents open a call, listen, rate caller happiness, add tags and notes, and click **Complete review**. |
| Assignment | Any QA user can multi-select calls and assign them to any QA Agent. Agents default to a "My assigned calls" filter and can switch to all calls. |
| Needs Follow Up / Critical Flags | A reviewer explicitly marks a call Needs Follow Up, or flags it Critical with required issue details. Admins resolve critical flags, which moves the call back to Reviewed. |
| Forwarding checks | An account with no calls for 36 business hours appears in the forwarding queue. A QA Agent tests the number and records PASS (reached AIRI) or FAIL. A FAIL automatically raises a Critical flag. |
| Team overview (admin) | Calls reviewed today, last call checked time, reviewer leaderboard, tag and sentiment counts, bot health. |
| Slack alerts | Posts to `#airi-qa-alerts` for completed Critical reviews, Needs Follow Up reviews, forwarding checks becoming due, and forwarding checks completed. |
| Account names | Recording folders can be UUIDs. The server resolves each to an account name from the HubSpot AIRI pipeline, falling back to the name in the bot's greeting. |

---

## 2. Tech stack

| Layer | Technology |
|---|---|
| Frontend | React 19 SPA, Vite 8, Tailwind 3, Axios. Built to `public/app/` and served as static files. |
| Backend | Node.js (Express 4). Single process; routes for this module live in `ai-bot-qc/routes.js`, mounted at `/api/ai-bot-qc`. |
| Database | SQLite via `better-sqlite3`, file `ai-bot-qc.db`, WAL mode. |
| Auth | Google OAuth 2.0 (Passport) with server-side sessions (`express-session`). |
| Recording storage | iDrive e2 (S3-compatible), accessed with `@aws-sdk/client-s3` using path-style URLs. |
| Integrations | HubSpot CRM API (deals search, AIRI pipeline), Slack incoming webhook, Google OAuth, Google Gemini API (bulletin text polish; `GEMINI_API_KEY`). |
| Hosting | DigitalOcean VPS, PM2 process `ccops`, domain `ops.answeringlegal.com`. |
| Security middleware | `helmet` (CSP), `cors`, `express-rate-limit` (auth routes only). |

### Data flow

```
Bot platform ──writes──> iDrive e2 bucket  recordings-v1-production/<customer>/<MM-DD-YY>/...
                              │  (read-only credentials)
                              ▼
Express API  ── index metadata/transcripts ──> ai-bot-qc.db (SQLite)
     │   ▲
     │   └── HubSpot deals (AIRI pipeline): account names, active/inactive, forwarding number
     ├── streams audio to the browser through /artifact (never exposes bucket URLs)
     └── POSTs alerts to Slack incoming webhook
React SPA ── session cookie ──> /api/ai-bot-qc/*
```

### Data stored in `ai-bot-qc.db`

`bot_calls` (call metadata, caller/destination phone, recording keys), `bot_reviews` (status, outcome, tags, notes, critical flag/details, reviewer, assignment, claim timing), `bot_review_events` (audit trail), `bot_forwarding_checks`, `bot_qc_bulletin*` (team announcements), `bot_qc_changes` (bug/feature requests), `bot_qc_excluded_phone_numbers` (internal test numbers), `bot_customer_names` (UUID to account name cache), `bot_slack_notices` (dedupe so each alert is sent once).

Sensitive data in scope: caller phone numbers, call audio and transcripts (may contain PII/legal-intake content), reviewer notes.

---

## 3. Authentication and authorization (current)

- **Login:** Google OAuth only. Callback is `/auth/google/callback`.
- **Who gets in:** only emails listed in `users.json` receive a role. Any other `@answeringlegal.com` account gets a limited `guest` session that is rejected by `requireAuth` and `requireRole`. Other domains are refused.
- **Session:** server-side session, cookie is `httpOnly`, `secure` in production, `sameSite=lax`, 8-hour expiry.
- **Roles for this module:** `ai_bot_qc` (QA Agent), `ai_bot_qc_admin` (QA admin), `super_admin`, and `ai_bot_qc_intern` (AIRI Intern, recording links only). Users can also have `additionalRoles`.
- **AIRI Intern:** can sign in and open `/?recording=<id>` (audio + transcript only). The server rejects every other QC route for this role, blocks recording downloads, and `requireAuth`/`isAuthedOrKey` reject intern-only users so they cannot call the rest of the dashboard APIs. Any additional role lifts the restriction.
- **Enforcement:** `router.use(requireRole(...QC_ROLES))` protects every route in the module, and admin-only routes add `requireRole(...QC_ADMIN_ROLES)`.
- **Return-to after login:** `?returnTo=` is accepted only if it starts with a single `/` (open-redirect protection).
- **Review claims:** opening a call claims it for 2 minutes. Edits and completion require owning the active claim (admins can override).

---

## 4. API endpoints

Base path: `/api/ai-bot-qc`. All require a logged-in session with `ai_bot_qc`, `ai_bot_qc_admin` or `super_admin`. "Admin" means `ai_bot_qc_admin` or `super_admin` only.

### Queue and reviews
| Method | Path | Access | Purpose |
|---|---|---|---|
| GET | `/queue` | QA | Paged call list. Filters: `status`, `critical`, `assigned=me`, `customer`, `reviewer_email`, `q`, `internal_tests`, `sort_by`, `sort_dir`, `limit` (max 500), `offset`. |
| GET | `/queue-summary` | QA | Counts for the agent view. |
| GET | `/calls/:id` | QA | One call with review state and history. |
| GET | `/calls/:id/recording` | QA | Recording-only view: account, date, duration, audio file keys and transcript. No review notes, tags or reviewer details. Used by the `/?recording=<id>` page that the CSV export links to (login required). |
| GET/POST/PUT/DELETE | `/outbound-tests/types`, `/outbound-tests/assignments[/:id[/answers\|submit\|review\|reopen\|call-click]]` | QA (agents see only their own; templates, assigning, review and delete are admin) | Scripted outbound QC tests: templates (seeded from the test docs), assignment to agents (optionally random), agent feedback form, admin review, audit events. Tables `bot_outbound_test_types`, `bot_outbound_tests`, `bot_outbound_events`. Kixie call/recording attachment is planned (Phase 2). |
| POST | `/calls/:id/claim` | QA | Claim a call for review (2-minute lease). |
| PUT | `/calls/:id/draft` | QA (claim holder) | Autosave tags, notes, happiness, outcome, critical flag/details. |
| POST | `/calls/:id/release` | QA (claim holder) | Release the claim, saving the draft. |
| POST | `/calls/:id/complete` | QA (claim holder) | Complete the review. Validates required fields. **Sends the Slack alert** for Critical or Needs Follow Up. |
| POST | `/calls/:id/reopen` | Admin | Reopen a reviewed call. |
| POST | `/calls/:id/resolve-critical` | Admin | Resolve a critical flag with a note and move the call back to Reviewed. |
| POST | `/calls/assign` | QA | Assign 1 to 100 calls to a QA Agent. Reviewed calls and actively claimed calls are rejected. |
| GET | `/agents` | QA | Assignable QA Agents. |

### Forwarding checks
| Method | Path | Access | Purpose |
|---|---|---|---|
| GET | `/forwarding-checks` | QA | Due and completed checks (HubSpot-gated). |
| POST | `/forwarding-checks/:customer/complete` | QA | Record `reached_airi` or `not_reaching_airi` plus notes. Re-validates account eligibility in HubSpot and that no newer call exists. A failure auto-flags Critical. |
| POST | `/forwarding-checks/:id/reopen` | QA | Reopen a completed check. |

### Recordings and storage
| Method | Path | Access | Purpose |
|---|---|---|---|
| GET | `/artifact` | QA (download: Admin) | Streams an audio/transcript file with HTTP Range support. The key must belong to an indexed call. |
| POST | `/sync` | QA | Re-index new recordings from the bucket. |
| GET | `/status`, `/buckets`, `/customers`, `/dates`, `/files` | QA | Storage browsing and health. |
| GET | `/account-names` | QA | UUID to account name map. Triggers resolution for new folders. |

### Admin and team
| Method | Path | Access | Purpose |
|---|---|---|---|
| GET | `/export` | Admin | CSV of reviewed calls with human feedback, tags, happiness, critical details and reviewer. Filters: `from`, `to` (YYYY-MM-DD, by review date), `critical=1`, `customer`, `reviewer_email`. Internal test calls excluded; cells are formula-injection safe. |
| GET | `/dashboard` | Admin | Team overview metrics (`period`, `reviewer_email`). |
| GET | `/history` | Admin | Activity history. |
| GET/POST/DELETE | `/excluded-phone-numbers` | Admin | Manage internal test numbers. |
| GET/POST/DELETE | `/bulletin`, `/bulletin/history`, `/bulletin/polish` | Admin (GET `/bulletin` is QA) | Team announcements. `/bulletin/polish` rewrites text with an AI call. |
| GET | `/review-criteria` | QA | Download the review criteria doc. |
| GET | `/training-user-guide` | Admin | Download the training guide. |
| GET/POST | `/changes` | GET: QA (first registration); POST: Admin | Bug and feature request log. |

---

## 5. Security controls in place

- OAuth-only login; role allowlist in `users.json`; guests cannot call app APIs.
- Role check on every route in the module; admin-only routes are separately gated.
- Cookie flags: `httpOnly`, `secure` (production), `sameSite=lax`.
- Helmet with a Content-Security-Policy (`connect-src 'self'`, `default-src 'self'`).
- Rate limit on login routes (20 per 15 minutes).
- Recordings are never exposed by direct URL. They are proxied through `/artifact`, which checks that the key belongs to an indexed call and that path segments contain no `/`, `\`, `..` or null bytes.
- Downloads of recordings are admin-only.
- Storage credentials are read-only (`s3:ListBucket`, `s3:GetObject`).
- All SQL uses prepared statements with bound parameters.
- Tag, happiness and outcome inputs are whitelisted and length-capped (feedback 10,000 characters, critical note 2,000).
- Actions are written to `bot_review_events` (audit trail), including who assigned, completed, reopened or resolved.
- Slack and HubSpot failures never block a review; Slack posts are fire-and-forget with an 8-second timeout, and each alert is deduplicated.

---

## 6. Gaps and recommended protections (for the dev team)

Ordered roughly by priority.

1. **CORS (FIXED: production now defaults to no cross-origin access; the server already sets `CLIENT_ORIGIN`).** Previously: CORS reflected any origin with credentials. `cors({ origin: process.env.CLIENT_ORIGIN || true, credentials: true })` echoes whatever origin is sent. `sameSite=lax` is the only thing limiting cross-site use. Set `CLIENT_ORIGIN` to `https://ops.answeringlegal.com` in production, or remove CORS since the SPA is same-origin.
2. **CSRF (MOSTLY FIXED: every `/api` route now rejects non-GET requests whose `Origin` host differs from the server host; a CSRF token would add defense in depth).** State-changing routes rely on `sameSite=lax` and JSON bodies. Add a CSRF token or require a custom header (for example `X-Requested-With`) on all non-GET routes.
3. **Session secret fallback (FIXED: the server now refuses to start in production without `SESSION_SECRET`).** `SESSION_SECRET` falls back to `dev-secret-change-in-prod`. Fail startup in production if it is unset.
4. **Dev auto-login.** When `NODE_ENV !== 'production'` and `GOOGLE_CLIENT_ID` is unset, every request is authenticated as `super_admin`. Make this opt-in with an explicit flag, and refuse to start with it on a public host.
5. **Session store (FIXED: sessions now persist in `sessions.db`, SQLite, expired rows pruned hourly).** Previously: the in-memory store. `express-session` uses the default `MemoryStore` (not for production, lost on every restart, leaks memory). Move to a persistent store (for example SQLite or Redis).
6. **Rate limiting (PARTIALLY FIXED: QC API is limited to 600 req/min/IP, `/sync` 6/min, `/bulletin/polish` 10/min, `/calls/assign` 30/min; other modules still unlimited).** Add limits to the API, especially `/sync` (reads the whole bucket), `/artifact` (streams audio), `/bulletin/polish` (calls the Gemini API and costs money) and `/calls/assign`.
7. **Assignment is not authorization.** Any QA user can read and edit any unreviewed call and can assign to anyone. If agents should be limited to their own calls, enforce it on the server in `/queue`, `/calls/:id` and `/artifact`, not only in the UI.
8. **Duplicate `/changes` routes (FIXED: duplicates removed; GET `/changes` is QA-readable, POST is admin-only).** `GET /changes` and `POST /changes` are registered twice (GET is QA-readable first, then admin-only later; POST is admin-only both times). Express uses the first match, so the later GET is dead code. Remove the duplicates and decide the intended access.
9. **Role changes (ALREADY OK: roles are re-read from `users.json` on every request, so removals take effect immediately).** Original concern: The role is copied into the session at login, so removing a user from `users.json` does not end their existing session for up to 8 hours. Re-check the role from `users.json` on each request, or shorten the session.
10. **Roles live in a flat JSON file.** `users.json` is read and written by the app with no locking. Consider moving it to the database.
11. **CSP allows `'unsafe-inline'` scripts.** Remove it by using hashes or nonces.
12. **API key bypass (NOTE: `DEV_API_KEY` is currently set on the production server).** `DEV_API_KEY` allows GET requests with `x-api-key` and no login. Confirm it is unset in production, or restrict it, (the comparison is now constant-time).
13. **Slack webhook is a shared secret.** It lives in `.env` as `SLACK_AIRI_QC_URL`. Rotate it if it is ever exposed, and keep `.env` out of git.
14. **No automated tests or monitoring.** There are no tests for the review state machine (claim, complete, reopen, resolve) or for the permission checks. Add tests for role enforcement on every route, and alerting for failed storage, HubSpot and Slack calls.
15. **Backups.** `ai-bot-qc.db` holds the only copy of reviews. A backup script exists (`scripts/backup-ai-bot-qc.cjs`); confirm it is scheduled and that restores are tested.

---

## 7. Configuration (environment variables)

| Variable | Purpose |
|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL` | Google OAuth. If the client ID is omitted outside production, dev auto-login is active (see gap 4). |
| `SESSION_SECRET` | Signs session cookies. |
| `NODE_ENV` | `production` enables secure cookies. |
| `IDRIVE_E2_ACCESS_KEY_ID`, `IDRIVE_E2_SECRET_ACCESS_KEY`, `IDRIVE_E2_BUCKET`, `IDRIVE_E2_ENDPOINT`, `IDRIVE_E2_REGION`, `IDRIVE_E2_PREFIX` | Recording storage (read-only). |
| `HUBSPOT_PRIVATE_APP_TOKEN` | AIRI pipeline lookups (account name, active status, forwarding number). |
| `SLACK_AIRI_QC_URL` | Incoming webhook for `#airi-qa-alerts`. |
| `SLACK_HITSQUAD_GROUP_ID`, `SLACK_QA_AGENTS_GROUP_ID` | Slack user-group IDs so mentions actually notify. |
| `GEMINI_API_KEY` | Bulletin polish. |
| `AI_BOT_QC_BUSINESS_TIMEZONE` | Business-hours clock for forwarding checks. |
| `APP_BASE_URL` | Base for links in Slack alerts. Defaults to `https://ops.answeringlegal.com`. |
| `CLIENT_ORIGIN` | Allowed CORS origin (see gap 1). |

## 8. Deployment

Production is a single VPS running PM2 (`ccops`). Deploy is `git pull origin main && pm2 restart ccops` on the server. The built client in `public/app/` is committed to git, so there is no build step on the server. The database file and `.env` live on the server only.
