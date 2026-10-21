# story-group-gtm

The live Story Group GTM system: Express backend (`backend/`) and React dashboard (`frontend/`). The parent folder's `../CLAUDE.md` is the main guide (where it runs, deploy, backend map, CRM, env vars, conventions) and loads with this file. Read it first. This file only adds repo details.

- The CRM is Nutshell. HubSpot and Coterie are retired: `services/hubspot.js` and `services/coteriehq.js` still get called but do nothing without keys, so swap in Nutshell when you touch that code.
- GitHub `vinniecatalano9/story-group-gtm`, branch `main`. No tests, no linter.
- npm scripts break on the colon in the folder path. Call binaries directly (`node --watch server.js`, `./node_modules/.bin/vite`).

## Data model extras
- Signal strengths: `hot` (1.5x), `warm` (1.0x), `cold` (0.5x).
- Reply classifications: `interested`, `not_interested`, `why_reach_out`, `more_info`, `cost_question`, `question_other`, `referral`, `re_engage`, `ooo`, `bounce`, `other`.
- Response macros: `CALL_TIME`, `WHY_REACH_OUT`, `MORE_INFO`, `COST_QUESTION`, `RE_ENGAGE`, `CASE_STUDY`, `POST_BOOKING`, `NONE`.

## Call scorecard (`frontend/public/call-scorecard/`)
Internal live-call panel for discovery and pitch calls: readiness scorecard, v6 beat tracker, rules-based package suggestion from the 9/18/26 packages, case studies that pop up on what the rep clicks, and instant search over objections, Aaron's answers, packages and cases. No AI on the call, localStorage only.
- Prefill: each pre-call brief email (`backend/cron/precall-brief.js`) carries an "Open pre-filled scorecard" link. Booking-form answers, the ad campaign (read from the booking link's name: PR, crisis or video) and the brief's research ride in the URL fragment (`#prefill=<base64url JSON>`, never sent to a server; base URL from `SCORECARD_URL`). Reps can also paste invite or form text via "Paste booking info".
- Its search index and case library are embedded. After PR Mastery, `tier_reference.md` or `Aaron-Selling-System.md` changes, run `node frontend/scripts/build-call-scorecard-kb.mjs`.
