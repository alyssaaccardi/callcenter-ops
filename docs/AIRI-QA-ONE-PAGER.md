# AIRI QA Platform — One-Page Overview

**What it is:** An internal web tool (part of the Dialed In Dash, ops.answeringlegal.com) where QA agents review recorded calls handled by AIRI, our AI voice answering bot, catch bad bot behavior, and escalate urgent issues.

## What it does
| Feature | Summary |
|---|---|
| **Review queue** | Every AIRI call is pulled automatically from recording storage. A QA agent listens, reads the transcript, rates caller happiness, adds tags and notes, and completes the review. |
| **Assignment** | Any QA user can assign one or many calls to a QA agent. Agents default to their own assigned calls. |
| **Critical / Needs Follow Up flags** | Reviewers flag problem calls (Critical requires issue details). Admins resolve critical flags. |
| **Forwarding checks** | An account with no calls for 36 business hours is queued for a test call to confirm forwarding still reaches AIRI. A failed test auto-raises a Critical flag. |
| **Slack alerts** | Posts to #airi-qa-alerts when a review is completed with a Critical or Needs Follow Up flag, and when forwarding checks become due or are completed. Each links to the call. |
| **Admin view** | Calls reviewed today, last call checked, reviewer activity, team bulletin, bot change log. |

## Tech stack
- **Frontend:** React 19, Vite, Tailwind
- **Backend:** Node.js, Express (single server)
- **Database:** SQLite (reviews, assignments, audit trail, sessions)
- **Login:** Google OAuth only; roles: QA agent, QA admin, super admin, AIRI Intern (recording links only)
- **Recordings:** iDrive e2 (S3-compatible), read-only access, streamed through the server
- **Integrations:** HubSpot (account names, active status, forwarding numbers), Slack (alerts), Gemini (bulletin text polish)
- **Hosting:** Single DigitalOcean VPS, PM2

## Security in place
- Google sign-in only; access limited to an approved user list with roles
- Role check on every QC endpoint; admin actions separately restricted
- Recordings never publicly linkable; streamed after an access check; downloads admin-only
- Parameterized SQL; input whitelists and length caps
- Audit trail of review actions
- Recent hardening: API rate limits, cross-site write blocking, persistent session store, required session secret in production, locked-down CORS

## Open items for the dev team
1. CSRF token (currently Origin check + `sameSite=lax`)
2. Remove inline scripts from the content security policy
3. Server-side limit so agents only access their own assigned calls (today it is a UI filter)
4. Rate limiting for the rest of the app beyond the QC module
5. Automated tests for roles and the review workflow; confirm scheduled DB backups

*Full detail (endpoint list, role matrix, gaps): [AIRI-QA-PLATFORM-TECHNICAL-OVERVIEW.md](./AIRI-QA-PLATFORM-TECHNICAL-OVERVIEW.md)*
