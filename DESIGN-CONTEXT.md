# Design Context — Dialed In Dash (callcenter-ops)

Context for a designer working on this app. Everything below is grounded in the code as of commit `decf188` (Foundations v1); file paths are cited so the designer can verify.

> **Status:** Foundations v1 has landed. A real token file and 13 exported primitives now exist, and `MinuteAuditor` is the one module fully converted to them. Everything else still renders against deprecated aliases and the legacy `index.css`. **Section 3.5 is the migration scoreboard** — read it before picking up work.

---

## 1. What this app does

**Dialed In Dash** is Answering Legal's internal ops portal — a single-page React app that stitches together the systems the ops team uses daily (Mitel PBX, ChargeOver billing, Zendesk, Monday.com, HubSpot, Bandwidth, Slack, Gmail) and adds workflows on top.

**Users** (source: `client/src/components/UserManagement.jsx:4`, roles mirrored in `components/layout/Sidebar.jsx:7-25`):

| Role | What they do |
|---|---|
| `super_admin` | Full access — engineering / leadership |
| `call_center_ops` | Call-center leads: status board, agent tools, SMS, Slack workflows |
| `support` | Support agents: their queue, account reviews, team leaderboard |
| `tech` | Tech team: tech queue, app portal (embedded internal app), leaderboard |
| `zendesk_auditor` | Reads cancellation ticket audits ("The Farewell Reporter") |
| `billing` | Runs billing audits: minute-usage, salesperson attribution, no-charge leaderboard |
| `newsletter_contributor` | Submits & reviews content for "The Ring Leader" internal newsletter |
| `scriptor` | Uses the Rob-osetta Stone transcription tool (chrome-less) |
| `tv_display` | Read-only wall-mounted TV pages, token-authenticated |

**Top 3 user tasks** (by daily volume / stakes):

1. **See system status at a glance and react to outages.** `StatusBoard` + the Sidebar status pill + TV displays (`DialedInPage`, `SupportTVPage`, `TechTVPage`, `AdminTVPage`) — the whole company glances at these all day.
2. **Triage support / tech queues.** `SupportCenter.jsx`, `TechCenter.jsx` — agent-level daily driver: see who's on what ticket, due times, working-on status pulled from Monday.
3. **Audit / reconcile data across systems.** `ZendeskAuditor` (cancellation reasons), `MinuteAuditor` (usage vs. paid subs), `AccountReview` — bursty but high-stakes.

---

## 2. Every screen / route

**Router:** `client/src/App.jsx:130-144` (React Router). Sidebar navigation swaps modules inside the `Dashboard` shell without changing the URL — the `activeModule` string is local state at `App.jsx:58`.

### Standalone routes

| Route | File | Purpose |
|---|---|---|
| `/login` | `pages/LoginPage.jsx` | Google-OAuth landing (52 lines) |
| `/dialed-in` | `pages/DialedInPage.jsx` + `.css` | Wall TV — mitel queues, status |
| `/support-dash` | `pages/SupportTVPage.jsx` + `.css` | Support-team wall TV |
| `/tech-dash` | `pages/TechTVPage.jsx` + `.css` | Tech-team wall TV |
| `/admin-tv` | `pages/AdminTVPage.jsx` | Admin/leadership wall TV |
| `/rob` | `pages/RobStonePage.jsx` | Rob-osetta Stone transcription (chrome-less) |
| `/dialed-in-pulse` | *(redirect → /support-dash)* | Legacy alias — `pages/PulsePage.{jsx,css}` kept but unrouted |
| `/mobile` | `pages/MobilePage.jsx` | Phone-sized dashboard |
| `/*` | `Dashboard` shell → module | See moduleMap below |

### Shell + module map (`App.jsx:71-91`)

`Dashboard` renders `Sidebar` + `Topbar` + `<main>`; the module inside `<main>` is picked from this map keyed on `activeModule`. Every module lives in `client/src/modules/`. Sidebar labels and section grouping come from `ALL_NAV_ITEMS` (`Sidebar.jsx:7-25`).

| Sidebar key | Sidebar label | Module file | Section | Roles |
|---|---|---|---|---|
| `status` | Status Board | `StatusBoard.jsx` | Operations | super_admin, call_center_ops |
| `sms` | SMS Messaging | `SmsModule.jsx` | Operations | super_admin, call_center_ops |
| `slack` | Slack Workflows | `SlackWorkflows.jsx` | Operations | super_admin, call_center_ops |
| `monday` | Agent Board | `AgentBoard.jsx` | Operations | super_admin, call_center_ops |
| `mitel-leaderboard` | Mitel Leaderboard | `MitelLeaderboard.jsx` + `.css` | Operations | super_admin, call_center_ops |
| `staff-broadcast` | Staff Site | `StaffBroadcast.jsx` + `.css` | Operations | super_admin, call_center_ops |
| `settings` | Settings | `Settings.jsx` | Operations | super_admin, call_center_ops |
| `support-center` | Support Center | `SupportCenter.jsx` (styles in `pages/SupportPage.css`) | Support | super_admin, support |
| `account-review` | Account Review | `AccountReview.jsx` + `.css` | Support | super_admin, support |
| `team-leaderboard` | Team Leaderboard | `TeamLeaderboard.jsx` + `.css` | Support | super_admin, support |
| `tech-center` | Tech Center | `TechCenter.jsx` + `.css` | Tech | super_admin, tech |
| `tech-leaderboard` | Team Leaderboard | `TechLeaderboard.jsx` | Tech | super_admin, tech |
| `app-portal` | App Portal | `AppPortal.jsx` + `.css` | Tech | super_admin, tech |
| `user-management` | User Management | `UserManagementModule.jsx` → `components/UserManagement.jsx` | Administration | super_admin |
| `admin-dashboard` | Admin Dashboard | `AdminDashboard.jsx` | Analytics | super_admin, call_center_ops, zendesk_auditor |
| `zendesk-auditor` | The Farewell Reporter | `ZendeskAuditor.jsx` | Analytics | super_admin, call_center_ops, zendesk_auditor |
| `minute-auditor` | Minute Usage Auditor | `MinuteAuditor.jsx` + `.css` | Billing | super_admin, call_center_ops, billing |
| `ring-leader` | The Ring Leader | `RingLeader.jsx` + `.css` | Newsletter | super_admin, newsletter_contributor |
| `scriptor` | The Rob-osetta Stone | `Scriptor.jsx` | Tools | super_admin, scriptor |

Modules are still monolithic — each `.jsx` is 400–1900 lines of local components. `MinuteAuditor` (659 lines) is the only one that now composes shared primitives instead of redefining them.

---

## 3. Design system today

Source of truth is **`client/src/styles/tokens.css`** (180 lines), `@import`ed at the top of `client/src/index.css`.

### Color

**Brand** — royal is the action color, violet is accent-only (roles, charts, brand mark):

```
--royal-050 #EAF2FE   --royal-100 #C3DCFB   --royal-500 #2C7FF0
--royal-600 #1A6FE8 (primary action, links, active nav)
--royal-700 #1559C4 (hover / pressed)
--violet-050 #F3EDFE  --violet-100 #DDD0FB
--violet-600 #7C3AED  --violet-700 #5B21B6
```

**State** — each with 050/100/500/600/700:

```
ok    #E8F8EE  #B7E7C9  #22C55E  #17914A  #0F7A3D
warn  #FEF4E4  #F7DFAE  #F59E0B  #B4700A  #94590A
crit  #FDECEC  #F6C6C6  #EF4444  #C42525  #A31D1D
```

**Neutral ramp** — 11 steps, cool, derived from the original navy: `--ink-900 #0B1220` → `--ink-050 #F2F5FA` → `--ink-000 #FFFFFF`.

**Semantic layer** — this is what components should actually reference, never the raw ramp:

```
--bg  --surface  --surface-sunken  --surface-raised
--border  --border-strong
--text  --text-strong  --text-muted  --text-subtle  --text-inverse
--focus-ring
```

Body renders on flat `--bg` (ink-050). The old four-stop diagonal gradient is **gone**, and frosted glass has been retired from admin surfaces (it survives in un-migrated CSS — see 3.5).

### Type

```
--font-display  'Barlow Condensed', 'Barlow', sans-serif
--font-sans     'Barlow', system-ui, sans-serif
--font-mono     'IBM Plex Mono', ui-monospace, monospace
```

9-step ramp, each with a paired line-height token:

| Token | Size | LH |
|---|---|---|
| `--fs-display` | 52px | 1.0 |
| `--fs-h1` | 32px | 1.05 |
| `--fs-h2` | 24px | 1.1 |
| `--fs-h3` | 18px | 1.25 |
| `--fs-body` | 15px | 1.5 |
| `--fs-ui` | 14px | 1.45 |
| `--fs-sm` | 13px | 1.45 |
| `--fs-label` | 12px | 1.4 |
| `--fs-micro` | 11px | 1.3 |

Weights `--fw-regular/medium/semibold/bold`; tracking `--track-tight` / `--track-micro`. `.num` / `.font-mono` apply `font-variant-numeric: tabular-nums`.

### Space, radius, elevation, motion

```
Space (4px base)  --sp-1 4  --sp-2 8  --sp-3 12  --sp-4 16  --sp-5 20
                  --sp-6 24  --sp-8 32  --sp-12 48  --sp-16 64
Radius            --r-sm 4  --r-md 8  --r-lg 12  --r-xl 16  --r-full 999px
Elevation         --elev-1 … --elev-4
Motion            --dur-fast 120ms  --dur-base 180ms  --dur-slow 260ms
                  --ease cubic-bezier(.2,.6,.3,1)
Layout            --sidebar-w 240px  --sidebar-w-collapsed 96px  --topbar-h 60px
```

### Dark mode

`body.dark` overrides live in the same file (`tokens.css:91-121`) — it re-points the semantic layer plus the 050/100/700 steps of every brand/state color and swaps the elevation set for darker shadows. **Any component built on the semantic tokens gets dark mode for free.** Components that hardcode hex do not.

### Focus

`:focus-visible { outline: 2px solid var(--royal-600); outline-offset: 2px }` is global (`tokens.css:146`). The old "no focus ring anywhere" problem is closed at the base layer.

### Deprecated aliases

`tokens.css:154-179` maps every legacy variable onto the new palette so un-migrated CSS keeps compiling: `--navy`, `--royal`, `--purple`, `--pink` (→ violet), `--teal` (→ ok), `--green`, `--success`, `--amber`, `--warn`, `--red`, `--danger`, `--white`, `--muted`, `--text-lt`, `--sans`, `--mono`, `--sidebar`. **Grep before deleting any line.**

---

## 3.5 Migration scoreboard

This is the most important section for anyone picking up work.

| Surface | Tokens | Primitives | Dark mode | Notes |
|---|---|---|---|---|
| `MinuteAuditor` | ✅ | ✅ full | ✅ | Only fully converted module. `MinuteAuditor.css` (388 lines) contains **zero hex literals**. |
| `TechCenter.css` | ✅ | — | ✅ | Zero hex literals, but no primitives yet. |
| `StatusBoard` | — | partial | ✅ | Only imports the pre-existing `Toggle`. |
| `SmsModule` | — | partial | ✅ | Only imports the pre-existing `GroupSelect`. |
| `MobilePage` | — | partial | — | Only imports `PillToggle`. |
| `index.css` (shell) | partial | — | ✅ | 880 lines, **44 distinct hex literals**, legacy `.btn`/`.card` still live. |
| `SupportPage.css` | — | — | ✅ | 989 lines, **42 hex** — largest un-migrated surface. |
| `AccountReview`, `RingLeader`, `TeamLeaderboard`, `StaffBroadcast` | — | — | ✅ | 12–17 hex each. |
| `MitelLeaderboard.css`, `AppPortal.css` | — | — | ❌ | **No `body.dark` block** — real dark-mode gaps. |
| TV pages (`SupportTVPage`, `TechTVPage`, `DialedInPage`, `PulsePage`) | — | — | n/a | Dark by design; separate visual language. |
| `App.css` | — | — | ❌ | Unused Vite scaffold — safe to delete. |

Current sprawl, measured across all CSS:
- **147 distinct hex colors** total; **108** of them outside `tokens.css`.
- **30 distinct `font-size` px values** (8 → 100) despite the 9-step ramp.
- **27 distinct `border-radius` declarations** despite the 5-value scale.
- `backdrop-filter` still in 7 files: `index.css`, `SupportPage.css`, `AccountReview.css`, `RingLeader.css`, `TeamLeaderboard.css`, `StaffBroadcast.css`, and `ui.css` (modal scrim — intentional).

---

## 4. Shared UI components

### Primitives — `client/src/components/ui/` (barrel: `index.js`, styles: `ui.css`, 219 lines)

All ship dark-mode CSS and a `:focus-visible` ring.

| Export | Variants / API surface (from `ui.css` classes) |
|---|---|
| `Button` | `--primary` `--secondary` `--ghost` `--danger` `--link`, sizes `--sm/--md/--lg`, `--block`, `__spinner` |
| `Card` | `--flat` `--hero` `--interactive` `--pad`, slots `__head` `__eyebrow` `__title` `__body` `__foot` |
| `Input` | `--error` `--mono`, `-wrap--icon`, plus `.ui-field` label/hint/error and `.ui-textarea` |
| `Select` | `.ui-select` |
| `Checkbox` | `--radio`, `__box` |
| `Badge` | `--ok` `--warn` `--crit` `--info` `--accent` `--neutral`, `--sm`, `__dot` |
| `Tag` | `--ok` `--warn` `--info` `--accent` `--neutral` |
| `StatusPill` | exports a `STATUS` map alongside |
| `Table` | `--comfortable`, `-wrap`, `-scroll`, `__arrow` `__foot` `__pager` `__page` |
| `DensitySwitch` | `.ui-density` — pairs with `Table` |
| `Modal` | `--wide`, `__scrim` `__head` `__title` `__desc` `__body` `__foot` |
| `EmptyState` | `__glyph` `__title` `__desc` `__actions` |
| `Tabs` | `__tab` `__count` |
| `GroupSelect` | pre-existing, re-exported unchanged |
| `BigToggle`, `PillToggle` | pre-existing, re-exported unchanged |

Import from the barrel: `import { Button, Card, Table } from '../components/ui'`.

### Layout — `client/src/components/layout/`

| Component | Lines | Purpose |
|---|---|---|
| `Sidebar.jsx` | 236 | Left nav, brand mark, collapse toggle, user footer. `ALL_NAV_ITEMS` (line 7) is the nav source of truth. Also owns the "Displays" sub-menu that opens TV pages in new windows. |
| `Topbar.jsx` | 123 | Greeting, tri-clock (EST/BZ/JM), global status pill. Fixed 60px (`--topbar-h`). |
| `Toast.jsx` | — | Ephemeral notifications, reads `useApp().toasts`. |

### Other global components — `client/src/components/`

| Component | Purpose |
|---|---|
| `DialingIn.jsx` + `.css` | Full-screen "connecting" splash used on TV pages |
| `UserBadge.jsx` | Small avatar + name pill — **still uses inline styles**, not classes |
| `UserManagement.jsx` | Admin-only user CRUD, role picker, tutorial-toggle grid (~900 lines). `ROLES` / `ROLE_STYLE` / `ROLE_LABEL` at the top define role visuals; keep in sync with `Sidebar.jsx`. |
| `WhatsNew.jsx` | Always mounted in the Dashboard shell; one-shot changelog cards from `server.js` tutorials |

### Legacy primitives still in `index.css`

`.card` (line 207), `.card-title`, `.btn` + `.btn-primary/-secondary/-teal/-danger/-success/-ghost/-sm/-lg` (lines 243-266), `.big-toggle`, `.toggle-pill`, `.form-select`, `.group-*`. These are **gradient-based purple→pink** and now visually conflict with the royal `ui-btn`. Every un-migrated module still uses them. Retire per-module, not wholesale.

---

## 5. Styling approach & constraints

- **Framework:** React (Vite build), plain `.css` files imported per module (`import './Foo.css'` at the top of `Foo.jsx`).
- **No CSS-in-JS, no Tailwind, no CSS Modules.** Class names are global; conflict avoidance relies on per-module prefixes (`.ui-*` primitives, `.ma-*` MinuteAuditor, `.ar-*` AccountReview, `.tl-*` TeamLeaderboard, `.rl-*` RingLeader, `.tv-*` TV pages). No linter enforces this.
- **Build output committed:** `public/app/` ships pre-built assets — the DO VPS does `git pull && pm2 restart`, no build on server. Any redesign must produce the same static-file output shape.
- **Fonts via CDN** in `client/index.html`. Foundations v1 added regular-width Barlow so `--font-sans` has a face; Bebas Neue + Press Start 2P stay loaded for the TV pages. Typography changes start here.
- **Dark mode toggle:** `body.dark`, handled in `AppContext.jsx`. New components built on semantic tokens inherit it; anything hardcoding hex must ship its own `body.dark` block.
- **Deploy:** `npm run build` at repo root → asset hashes change → commit `public/app/index.html` + hashed assets → `git push` → `ssh root@165.22.11.251 "cd /opt/ccops && git pull && pm2 restart ccops"`.

---

## 6. Known UI problems

Roughly in "most user-hurting" order. Items closed by Foundations v1 are listed at the bottom for the record.

1. **Two design systems running side by side.** Royal-blue tokenized primitives on `MinuteAuditor`; purple/pink gradient `.btn` + frosted glass everywhere else. Moving between modules reads as moving between two apps. This is now the single biggest visual problem — worse than the pre-Foundations inconsistency, and it stays that way until adoption spreads.
2. **Primitive adoption is one module deep.** 13 primitives exist; exactly one module composes them. Every un-migrated module still reinvents buttons, cards, tables, tiles, badges, empty states.
3. **108 hex literals outside the token file.** `index.css` alone holds 44, `SupportPage.css` 42. State colors still ship from four different definitions that all render as "red."
4. **Type scale drift persists.** 30 distinct `font-size` values in CSS against a 9-step ramp — the same "secondary label" is 9px on one page and 12px on another.
5. **Two real dark-mode gaps:** `MitelLeaderboard.css` and `AppPortal.css` have no `body.dark` block and break visually in dark mode. (TV pages are dark by design; `App.css` is dead.)
6. **`SupportCenter` is the largest un-migrated surface** — 740 lines of JSX against 989 lines of `SupportPage.css`, ~5 working states per ticket with subtle differentiation, and its own loading/empty/sort/filter idioms.
7. **Frosted-glass fatigue** in the 6 files that still use `backdrop-filter` — primary content doesn't pop because every panel has the same treatment.
8. **TV pages are a separate visual language** (Bebas Neue + Press Start 2P + navy). Open question for the designer: unify, or keep explicitly parallel?
9. **Sidebar brand-mark hack.** `.sidebar-brand-name { margin-top: -62px }` (`index.css`) overlaps the wordmark onto the logo image.
10. **`UserBadge` uses inline styles** (`components/UserBadge.jsx:7-13`) instead of classes.
11. **Sidebar collapse is jerky** on Chromium — the `240px → 96px` width change transitions `margin-left` on `<main>` and reflows the whole content area.

**Closed by Foundations v1:** no design tokens · no shared primitives · no focus ring · body-gradient background · frosted glass on admin surfaces · `MinuteAuditor`'s ad-hoc `.ma-*` visual language.

---

## 7. Next screens to convert

Ranked by impact × effort, now that the primitives exist.

### 1. `Sidebar.jsx` + `Topbar.jsx` — the shell
**Why first (promoted):** These frame every module, so converting them propagates coherence everywhere at once — and right now the shell is the seam where the two design systems visibly collide. It's also what makes items 1 and 9 above go away. Kill the `-62px` brand hack, move the collapse transition off `margin-left`, and rationalize the sidebar sections while you're in there.

### 2. `StatusBoard.jsx` (463 lines) — home for the ops role
**Why:** Default landing for `super_admin` and `call_center_ops`, and the most-glanced-at screen in the building. Currently a flat wall of `.sb-panel` cards where everything competes for attention.
**Priorities:** distinguish "everything is fine" from "something is on fire"; give the eye one focal point. `Card --hero` + `StatusPill` map onto this almost directly.

### 3. `SupportCenter.jsx` (740 lines, `pages/SupportPage.css` 989 lines)
**Why:** Daily driver for the largest role by seat count, and the biggest single block of un-migrated CSS.
**Priorities:** ticket-row density (use `Table` + `DensitySwitch`), a coherent working-state color language off the `ok/warn/crit` ramps, mobile quick-glance path — many reps check on phones.

### 4. `MitelLeaderboard.css` + `AppPortal.css` — close the dark-mode holes
**Why:** Small, mechanical, and fixes an outright-broken state for dark-mode users. Converting them to semantic tokens removes the need for a `body.dark` block entirely.

### 5. `LoginPage.jsx` (52 lines) — first impression
**Why:** The one screen an external client might be shown. Cheap to elevate and it disproportionately shapes "does this app look serious."
**Priorities:** brand mark treatment, empty-state copy, dark mode.

---

## Appendix — files to touch first

- `client/src/styles/tokens.css` — **the** source of truth for color, type, space, radius, elevation, motion. Token changes start and end here.
- `client/src/components/ui/ui.css` + `index.js` — the 13 primitives and the barrel export.
- `client/src/index.css` — 880 lines of legacy shell: sidebar, topbar, `.btn`, `.card`. Shrinks as modules migrate.
- `client/src/modules/MinuteAuditor.{jsx,css}` — **the reference implementation.** Copy its patterns when converting another module.
- `client/src/App.jsx` — routing + role-based module map (`moduleMap`, line 71).
- `client/src/components/layout/Sidebar.jsx` — `ALL_NAV_ITEMS` (line 7) is the nav source of truth.
- `client/src/components/UserManagement.jsx` — `ROLES` / `ROLE_STYLE` / `ROLE_LABEL` define role visuals; keep in sync with `Sidebar.jsx`.
- `client/index.html` — Google Fonts `<link>` tags.
