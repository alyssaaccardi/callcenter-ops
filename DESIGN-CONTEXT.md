# Design Context — Dialed In Dash (callcenter-ops)

Context for a designer redesigning this app. Everything below is grounded in the code as of this commit; file paths are cited so the designer can verify.

---

## 1. What this app does

**Dialed In Dash** is Answering Legal's internal ops portal — a single-page React app that stitches together the systems the ops team uses daily (Mitel PBX, ChargeOver billing, Zendesk, Monday.com, HubSpot, Bandwidth, Slack, Gmail) and adds workflows on top.

**Users** (source: `client/src/components/UserManagement.jsx:4`):

| Role | What they do |
|---|---|
| `super_admin` | Full access — engineering / leadership |
| `call_center_ops` | Call-center leads: status board, agent tools, SMS, Slack workflows |
| `support` | Support agents: their queue, account reviews, team leaderboard |
| `tech` | Tech team: tech queue, app portal (embedded internal app), leaderboard |
| `zendesk_auditor` | Reads cancellation ticket audits ("Farewell Reporter") |
| `minute_auditor` | Runs monthly minute-usage vs. ChargeOver audits (new module) |
| `newsletter_contributor` | Submits & reviews content for "The Ring Leader" internal newsletter |
| `scriptor` | Uses the Rob-osetta Stone transcription tool (chrome-less) |
| `tv_display` | Read-only wall-mounted TV pages, token-authenticated |

**Top 3 user tasks** (by daily volume / stakes):

1. **See system status at a glance and react to outages.** `StatusBoard` + the Sidebar status pill + TV displays (`DialedInPage`, `SupportTVPage`, `TechTVPage`, `AdminTVPage`) — the whole company glances at these all day.
2. **Triage support / tech queues.** `SupportCenter.jsx`, `TechCenter.jsx` — agent-level daily driver: see who's on what ticket, due times, working-on status pulled from Monday.
3. **Audit / reconcile data across systems.** `ZendeskAuditor` (cancellation reasons), `MinuteAuditor` (usage vs. paid subs), `AccountReview` — bursty but high-stakes; the auditor screens are the newest and most under-polished.

---

## 2. Every screen / route

**Router:** `client/src/App.jsx:130-144` (React Router). Sidebar navigation swaps modules inside the `Dashboard` shell without changing the URL — the `activeModule` string is local state at `App.jsx:58`.

### Standalone routes

| Route | File | Purpose |
|---|---|---|
| `/login` | `pages/LoginPage.jsx` | Google-OAuth landing |
| `/dialed-in` | `pages/DialedInPage.jsx` + `DialedInPage.css` | Wall TV — mitel queues, status |
| `/support-dash` | `pages/SupportTVPage.jsx` + `SupportTVPage.css` | Support-team wall TV |
| `/tech-dash` | `pages/TechTVPage.jsx` + `TechTVPage.css` | Tech-team wall TV |
| `/admin-tv` | `pages/AdminTVPage.jsx` | Admin/leadership wall TV |
| `/rob` | `pages/RobStonePage.jsx` | Rob-osetta Stone transcription (chrome-less) |
| `/dialed-in-pulse` | *(redirect → /support-dash)* | Legacy alias — see also `pages/PulsePage.{jsx,css}` (kept but no route) |
| `/mobile` | `pages/MobilePage.jsx` | Phone-sized dashboard |
| `/*` | `Dashboard` shell → module | See moduleMap below |

### Shell + module map (`App.jsx:71-91`)

`Dashboard` renders `Sidebar` + `Topbar` + `<main>`; the module inside `<main>` is picked from this map keyed on `activeModule`. Every module lives in `client/src/modules/`.

| Sidebar key | Module file | Section | Roles that see it |
|---|---|---|---|
| `status` | `StatusBoard.jsx` | Operations | super_admin, call_center_ops |
| `sms` | `SmsModule.jsx` | Operations | super_admin, call_center_ops |
| `slack` | `SlackWorkflows.jsx` | Operations | super_admin, call_center_ops |
| `monday` | `AgentBoard.jsx` | Operations | super_admin, call_center_ops |
| `mitel-leaderboard` | `MitelLeaderboard.jsx` + `.css` | Operations | super_admin, call_center_ops |
| `staff-broadcast` | `StaffBroadcast.jsx` + `.css` | Operations | super_admin, call_center_ops |
| `settings` | `Settings.jsx` | Operations | super_admin, call_center_ops |
| `support-center` | `SupportCenter.jsx` (styles in `pages/SupportPage.css`) | Support | super_admin, support |
| `account-review` | `AccountReview.jsx` + `.css` | Support | super_admin, support |
| `team-leaderboard` | `TeamLeaderboard.jsx` + `.css` | Support | super_admin, support |
| `tech-center` | `TechCenter.jsx` + `.css` | Tech | super_admin, tech |
| `tech-leaderboard` | `TechLeaderboard.jsx` | Tech | super_admin, tech |
| `app-portal` | `AppPortal.jsx` + `.css` | Tech | super_admin, tech |
| `user-management` | `UserManagementModule.jsx` → `components/UserManagement.jsx` | Administration | super_admin |
| `admin-dashboard` | `AdminDashboard.jsx` | Analytics | super_admin, call_center_ops, zendesk_auditor |
| `zendesk-auditor` | `ZendeskAuditor.jsx` | Analytics | super_admin, call_center_ops, zendesk_auditor |
| `minute-auditor` | `MinuteAuditor.jsx` + `.css` | Billing | super_admin, call_center_ops, minute_auditor |
| `ring-leader` | `RingLeader.jsx` + `.css` | Newsletter | super_admin, newsletter_contributor |
| `scriptor` | `Scriptor.jsx` | Tools | super_admin, scriptor |

**Component instances** used inside these modules: they're monolithic — each `.jsx` file is 500–1900 lines of local components. Very little cross-module reuse.

---

## 3. Design system today (what's actually in the code)

Everything below is from `client/src/index.css` unless otherwise noted. `client/src/App.css` is unused Vite scaffold — safe to delete.

### Color tokens (`index.css:1-31`)

```
--navy       #0e1828     --purple     #7c3aed
--navy-dk    #070d18     --purple-lt  #a855f7
--navy-lt    #162035     --pink       #ec4899
--royal      #1a6fe8     --teal       #00c9b1
--royal-dk   #1559c4     --teal-dk    #00a894
--green      #22c55e     --amber      #f59e0b
--red        #ef4444     --white      #f0f4ff
--red-dk     #dc2626     --muted      #8b7fa8
--success    #22c55e     --warn       #f59e0b
--danger     #ef4444     --danger-dk  #dc2626

--surface    rgba(255,255,255,0.72)
--text       #1a1a3e
--text-lt    rgba(26,26,62,0.55)
--border     rgba(168,85,247,0.15)
--sidebar    240px
```

**Body background** (light): a four-stop diagonal gradient `#e8eaf6 → #f3e8ff → #fce4f0 → #e0f7f4` (`index.css:39`). Dark mode: `#070d18 → #0a0f1e`.

### Fonts (`index.css:23-24`)

```
--sans   'Barlow Condensed', sans-serif
--mono   'IBM Plex Mono', monospace
```

Also present but **not in tokens** — loaded ad-hoc in module CSS:
- `'Bebas Neue'` — heavy use on TV pages (`TechTVPage.css`, `SupportTVPage.css`, `PulsePage.css`)
- `'Press Start 2P'` — TV "UP" retro flourish
- `'Inter'`, `'Helvetica Neue'`, `system-ui` — sporadic overrides (a few modules)

### Type scale — inferred, not declared

There's no `--font-size-*` token. Actual sizes in use across CSS: **9, 10, 11, 12, 12.5, 13, 14, 15, 16, 17, 18, 20, 22, 26, 28, 30, 36** px + several `clamp(...)` responsive scales on TV pages. There is no ramp — sizes are picked per component.

### Spacing — no scale

Padding/gap/margin values used (partial inventory from CSS grep): `2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14, 16, 18, 20, 22, 24, 28, 32, 38, 40, 44, 48, 60, 72, 88` px. Effectively arbitrary. No `--space-*` tokens.

### Border radii — 19 distinct values

`2, 3, 4, 5, 6, 7, 8, 10, 12, 14, 16, 20, 22, 24, 40, 50%, 99px, 999px, 0 8px 8px 0`. The most common are **6, 8, 10, 12** — a tighter scale would be `4 / 8 / 12 / 16 / full`.

### Shadows

No shared shadow tokens. Every panel/card rolls its own. Common patterns:
- Panels: `0 4px 24px rgba(168,130,220,0.10)`, `0 8px 32px rgba(168,130,220,0.16)`
- Modals: `0 24px 60px rgba(80,40,160,0.18)`, `0 32px 80px rgba(80,40,160,0.22)`
- Buttons: `0 2px 12px rgba(168,85,247,0.3)` (primary), grows on hover
- Sidebar: `2px 0 24px rgba(180,160,220,0.10)`

### Global surface style

Frosted glass everywhere: `rgba(255,255,255,0.72)` background + `backdrop-filter: blur(8px)` + `1px solid rgba(168,85,247,0.12)` border + `border-radius: 12–14px`. Used in cards, panels, dropzones, table wrappers.

### Inconsistencies / one-offs to know about

- **~120 distinct hex colors** across CSS files. Big chunks of duplicated blue/purple/green shades — e.g. `#7c3aed`, `#6d28d9`, `#8b5cf6`, `#6b21a8`, `#4338ca`, `#6b47b8`, `#3c1d8f` are all "purple". The token file only defines two.
- **Two typography families in play at once** on TV pages (Bebas Neue for numbers, Barlow Condensed for labels, IBM Plex Mono for metadata).
- **Dark mode is only implemented in `index.css`** (via `body.dark`) — module CSS files (Minute Auditor, Ring Leader, Mitel Leaderboard) have no `body.dark` variants. Effect: partial dark mode looks broken in newer modules.
- **`.card` primitive exists** (`index.css:238`) but most modules define their own `.<prefix>-panel` from scratch instead.
- **Prefix collision risk**: modules use per-module class prefixes (`.ma-*` MinuteAuditor, `.ar-*` AccountReview, `.tl-*` TeamLeaderboard, `.rl-*` RingLeader, `.tv-*` TV pages) but no linter/convention enforces it — some modules just use unprefixed class names inside their scope.

---

## 4. Shared UI components

### Layout — `client/src/components/layout/`

| Component | Purpose | Notes |
|---|---|---|
| `Sidebar.jsx` | Left nav, brand mark, collapse toggle, user footer | 234 lines. Section labels + nav items built from an `ALL_NAV_ITEMS` array filtered by role. Also owns the "Displays" sub-menu that opens TV pages in new windows. |
| `Topbar.jsx` | Greeting, dual/tri-clock (EST/BZ/JM), global status pill | 130-ish lines. Fixed 60px height. |
| `Toast.jsx` | Ephemeral notifications | Reads `useApp().toasts`. |

### Global widgets — `client/src/components/`

| Component | Purpose |
|---|---|
| `DialingIn.jsx` + `DialingIn.css` | Full-screen "connecting" splash used on TV pages |
| `UserBadge.jsx` | Small avatar + name pill — **uses inline styles**, not a shared class |
| `UserManagement.jsx` | Admin-only user CRUD, role picker, tutorial-toggle grid (~900 lines) |
| `WhatsNew.jsx` | Mounted always inside Dashboard shell; shows one-shot changelog cards from `server.js` tutorials |

### UI primitives — `client/src/components/ui/`

Only two exist:

| Component | Props | Where used |
|---|---|---|
| `GroupSelect.jsx` | `{ groups, selected, onChange, loading }` | Multi-select typeahead. `SmsModule`, `StaffBroadcast`. Uses `.group-search-wrap`, `.group-sel-tag`, `.group-dropdown` classes defined in `index.css`. |
| `Toggle.jsx` | `{ id, checked, onChange, big }` | Renders `.big-toggle` or `.toggle-pill` variant. `Settings`, `UserManagement`. |

**No shared** Button, Card, Input, Modal, Table, Dropdown, or Badge component. Each module inlines its own — the global `.btn`, `.card`, `input[type="text"]` styles in `index.css` are used inconsistently. A designer redesigning this will almost certainly want to introduce a real primitive set.

---

## 5. Styling approach & constraints

- **Framework:** React (Vite build), plain `.css` files imported per module (`import './Foo.css'` at the top of `Foo.jsx`).
- **No CSS-in-JS, no Tailwind, no CSS Modules.** Class names are global; conflict avoidance relies on the per-module prefix convention.
- **Bundle:** Vite ships a single 171 KB CSS bundle (`public/app/assets/index-<hash>.css`) served as a static asset.
- **Build output committed:** the `public/app/` folder ships pre-built assets — the DO VPS just does `git pull && pm2 restart`, no build on server. Any redesign must produce the same static-file output shape.
- **Fonts loaded via CDN link** in `client/index.html` (Google Fonts). If the redesign changes typography, the `<link>` tags there need updating.
- **Dark mode toggle**: `body.dark` class. Toggle handled in `AppContext.jsx`. Any new component must ship dark-mode CSS if it wants to work in dark mode.
- **Frontend deploy pipeline:** `npm run build` at repo root → asset hashes change → commit `public/app/index.html` + hashed assets → git push → `ssh root@165.22.11.251 "cd /opt/ccops && git pull && pm2 restart ccops"`.
- **Backwards compatibility:** class name changes must be done wholesale — no consumer of `.card` outside this repo, but many modules re-use `.btn`, `.btn-primary`, `.btn-secondary`. Rename with care.

---

## 6. Known UI problems

Roughly in "most user-hurting" order:

1. **No shared primitives** → each new module reinvents buttons, cards, tables, tiles, badges, empty states, progress bars. See `MinuteAuditor.css`, `RingLeader.css`, `AccountReview.css` — three completely different visual languages for the same conceptual "panel + table".
2. **Type scale drift.** Same information ("secondary label") is 9px on one page, 11px on another, 12px in a third. The visual weight of any given screen depends on which module you happen to be looking at.
3. **~120 hex colors, 2 tokens.** Ops leadership can't tell at a glance whether a state color means the same thing across modules — e.g. `#dc2626` (my code) vs `--danger` vs `--red-dk` vs `#ef4444` all show as "red" but ship from different definitions.
4. **Partial dark mode.** `MinuteAuditor`, `RingLeader`, `MitelLeaderboard` don't ship `body.dark` overrides — the app breaks visually if a dark-mode user lands there.
5. **Table density is uneven.** `MinuteAuditor` (11-column table with mismatch comparisons), `MitelLeaderboard` (10-column agent table), `TeamLeaderboard` all handle sticky headers, sort arrows, row hover, empty state differently.
6. **Frosted-glass fatigue.** Almost every panel uses the same `rgba(255,255,255,0.72)` + `backdrop-filter: blur` recipe, so the primary hero content on any given screen doesn't visually pop.
7. **TV pages ("Displays") are a whole separate visual language** (Bebas Neue + Press Start 2P + navy backgrounds) — they live under the same app but the design has no relationship to the admin dashboard. A designer will need to decide whether to unify or keep them explicitly parallel.
8. **`UserBadge` uses inline styles** (`client/src/components/UserBadge.jsx:7-13`) instead of CSS classes — one of several places where inline `style={{...}}` fights the CSS.
9. **Sidebar collapse animation is jerky** on chromium — the layout shift (`--sidebar: 240px → 96px`) via CSS `transition: margin-left 0.2s` triggers reflow of the entire main area.
10. **No focus-visible ring anywhere.** Keyboard nav is invisible outside of the browser default outline.

---

## 7. Top 5 screens to redesign first

Ranked by impact × effort.

### 1. `MinuteAuditor.jsx` — Minute Usage Auditor
**Why first:** Newest module (built this week), still churning as requirements settle. The visual language (`.ma-*` classes in `MinuteAuditor.css`) was designed one hero card at a time and it shows — headline flag card + reason breakdown + context tiles + filter row + legend + 11-column comparison table stack vertically with no visual rhythm. High-stakes billing audit; ops team will use this monthly on every customer.
**Redesign priorities:** clear source-labelling (Answer vs ChargeOver), tighter comparison cell design, shrink 11 columns into ~6 with progressive disclosure.

### 2. `StatusBoard.jsx` — home for the ops role
**Why:** Default landing for `super_admin` and `call_center_ops`. Currently a wall of `.sb-panel` cards driven by status polling. Reused primitives (`.card`, `.sb-panel.up/.down`) are old and the "at-a-glance" information hierarchy is flat — everything competes for attention.
**Redesign priorities:** distinguish "everything is fine" from "something is on fire"; give the eye a single focal point.

### 3. `SupportCenter.jsx` (styles in `pages/SupportPage.css`, 989 lines)
**Why:** The daily driver for the largest role by seat count (support). Supports ~5 different working states per ticket (working / due-soon / overdue / done / archived) and the visual differentiation between them is subtle. Empty state, loading, sort/filter controls all diverge from the rest of the app.
**Redesign priorities:** ticket-row density, working-state color language, mobile-quick-glance path (many support reps check on phones).

### 4. `Sidebar.jsx` + `Topbar.jsx` (the shell)
**Why:** These frame every module. A redesign of the shell will multiply visual coherence across every downstream page. Currently the shell has (a) a brand image plus wordmark that overlaps with negative margin (`.sidebar-brand-name { margin-top: -62px }` — a known hack), (b) an "operational/standby" status pill that repeats what `StatusBoard` shows, (c) a Displays sub-menu whose expand animation stutters on collapse.
**Redesign priorities:** define the app's information hierarchy at the chrome level; rationalize sidebar sections; make the collapse motion smooth.

### 5. `LoginPage.jsx` — first impression
**Why:** The one screen an external client would see if they were shown the app. Currently plain — Google button + logo. Cheap to elevate and it disproportionately shapes "does this app look serious."
**Redesign priorities:** brand mark treatment, empty-state marketing copy, dark-mode support.

---

## Appendix — files a designer will want to touch first

- `client/src/index.css` — global tokens, base primitives (`.btn`, `.card`, `.form-select`), sidebar & topbar styles. Any token refresh starts here.
- `client/src/App.jsx` — routing + role-based module map. Add/remove screens here.
- `client/src/components/layout/Sidebar.jsx` — `ALL_NAV_ITEMS` is the nav source of truth.
- `client/src/components/UserManagement.jsx` — the `ROLES`, `ROLE_STYLE`, `ROLE_LABEL` maps at the top define role visuals; keep in sync with `Sidebar.jsx`.
- `client/index.html` — Google Fonts `<link>` tags. Font swaps happen here.
