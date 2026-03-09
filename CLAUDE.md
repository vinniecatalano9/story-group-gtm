# Story Group GTM Engine — Node.js App

This is the **primary GTM engine** for Story Group. The n8n workflow version (`story-group-gtm-engine/`) is deprecated — all future development happens here.

## Workflow

- **Repo**: `github.com/vinniecatalano9/story-group-gtm` (branch: `main`)
- **Deploy**: `story-group-gtm.web.app` (Firebase Hosting, manual deploy for now)
- **Dev flow**: Make changes locally in Claude Code → commit → `git push origin main`
- No CI/CD yet. Firebase deploy is manual (`cd frontend && firebase deploy`).

## What It Does

Automated lead generation pipeline for Story Group's PR/media services:
**Ingest → Enrich → Score → Email via Instantly → Handle Replies → Sync to HubSpot**

## Commands

```bash
# Backend
cd backend && npm install && npm run dev   # node --watch server.js, port 3001

# Frontend
cd frontend && npm install && npm run dev  # Vite dev server
npm run build                               # Production build
```

No tests. No linter.

## Architecture

### Backend (`backend/`)

**Entry point**: `server.js` — Express on port 3001. Mounts all routes, cron jobs, and dashboard/leads/replies REST endpoints.

**Routes**:
| Route | File | Purpose |
|-------|------|---------|
| `POST /api/ingest` | `routes/ingest.js` | Accept leads (JSON, CSV upload via multer, Apify webhook). Normalize, dedup by email, store in Firestore. |
| `POST /api/enrich` | `routes/enrich.js` | Pull `ingested` leads (batch of 10), scrape website (Apify), search news, Claude signal detection, waterfall email, score, push to Instantly, sync to HubSpot. Main pipeline route. |
| `POST /api/reply` | `routes/replies.js` | Instantly reply webhook. Claude classifies reply, routes by type (interested→notify, not_interested/bounce→remove from Instantly, etc.), syncs HubSpot, notifies Slack. |
| `POST /api/scraper` | `routes/scraper.js` | Apify scraper management. |
| `GET /api/dashboard` | `server.js` | Pipeline stats for frontend. |
| `GET /api/leads` | `server.js` | Paginated lead list (filter by status/tier). |
| `GET /api/replies` | `server.js` | Paginated reply list (filter by classification). |
| `POST /api/trigger/cleanup` | `server.js` | Manual cleanup trigger. |
| `POST /api/trigger/dashboard` | `server.js` | Manual dashboard report trigger. |
| `GET /api/health` | `server.js` | Health check. |

**Services** (`backend/services/`):
- `db.js` — Firebase Admin + Firestore. Collections: `leads`, `replies`, `logs`. Functions: addLead, updateLead, getLeadByEmail, getLeadsByStatus, addReply, addLog, getLeadStats, getLeadsPage, getRepliesPage.
- `claude.js` — Shells out to Claude Code CLI (`claude -p`). `claudeJSON()` parses JSON from responses.
- `instantly.js` — Instantly API v2. Batched campaign uploads (100 at a time), ESG cleanup, 429 retry.
- `hubspot.js` — HubSpot CRM v3. Creates/updates contacts with `gtm_*` custom properties. Gracefully skips if no API key.
- `slack.js` — Slack webhook notifications for new replies.

**Libs** (`backend/lib/`):
- `normalize.js` — `normalizeLead()` maps varied field names to canonical schema. Strips company suffixes, normalizes titles (CEO, CFO, etc.), cleans domains, validates emails.
- `scoring.js` — `scoreLead()` returns `{ score, tier }`. Signal base scores (0-30) * strength multiplier (0.5-1.5x) + base attributes (email +10, LinkedIn +5, C-suite +15, domain +5). Tiers: priority (60+), standard (30-59), nurture (<30), manual_review (no email).
- `email-patterns.js` — Waterfall email pattern generation from name + domain.

**Cron** (`backend/cron/`):
- `cleanup.js` — Weekly stale lead cleanup from Instantly (Sun 11pm EST).
- `dashboard.js` — Weekly metrics aggregation (Mon 8am EST).

### Frontend (`frontend/`)

React 18 + Vite + Tailwind CSS + React Router. Firebase Hosting.

Three pages:
- `Dashboard.jsx` — Pipeline funnel + KPI cards + quick action buttons.
- `Leads.jsx` — Lead table with status/tier filters.
- `Replies.jsx` — Reply list with classification filters.

## Lead Data Model

**Statuses**: `ingested` → `enriching` → `enriched` → `scored` → `emailed` → `replied` → `booked` → `dead` (also `enrichment_failed`, `manual_review`)

**Tiers**: `priority` (60+), `standard` (30-59), `nurture` (<30), `manual_review` (no email)

**Signal types**: `funding_growth`, `competitor_pr`, `leadership_change`, `product_launch`, `negative_press`, `hiring_comms`, `active_ad_spend`, `industry_event`, `content_gap`, `no_signal`

**Signal strengths**: `hot` (1.5x), `warm` (1.0x), `cold` (0.5x)

**Reply classifications**: `interested`, `not_interested`, `why_reach_out`, `more_info`, `cost_question`, `question_other`, `referral`, `re_engage`, `ooo`, `bounce`, `other`

**Response macros**: `CALL_TIME`, `WHY_REACH_OUT`, `MORE_INFO`, `COST_QUESTION`, `RE_ENGAGE`, `CASE_STUDY`, `POST_BOOKING`, `NONE`

## Canonical Lead Schema

```js
{
  lead_id, first_name, last_name, email, company_name, company_domain,
  role_title, linkedin_url, source, campaign_tag, status, score, tier,
  signal_type, signal_strength, signal_summary, company_description,
  detected_industry, instantly_campaign_id, hubspot_contact_id,
  created_at, updated_at
}
```

## Environment Variables

```
PORT=3001
INSTANTLY_API_KEY, INSTANTLY_CAMPAIGN_PRIORITY, INSTANTLY_CAMPAIGN_STANDARD, INSTANTLY_CAMPAIGN_NURTURE
APIFY_API_TOKEN
HUBSPOT_API_KEY
SLACK_WEBHOOK_URL
NOTIFICATION_EMAIL
CALENDLY_LINK
GOOGLE_APPLICATION_CREDENTIALS (path to Firebase service account JSON)
FIREBASE_PROJECT_ID
MAX_LEADS_PER_HOUR=50, MAX_INSTANTLY_BATCH_SIZE=100, MAX_CLEANUP_PER_RUN=500
```

## Conventions

- Backend: CommonJS (`require`/`module.exports`). Frontend: ESM (`import`/`export`).
- Env vars read lazily via functions to allow runtime config.
- External API failures are caught and warned, never thrown — pipeline continues with degraded data.
- Lead fields use `snake_case` internally; Instantly custom variables use `camelCase`.
- Intent signals are for scoring only — not used in email body. Vincent handles all email copy in Instantly.
