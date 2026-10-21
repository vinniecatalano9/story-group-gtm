# RingCentral call transcripts: setup

Goal: every RingCentral phone call shows up on the Transcripts page with a summary, action items, and a follow-up draft, the same as a Fireflies meeting. Optionally, a recap email lands in your inbox.

## How it works

1. You make or take a call on RingCentral. Auto call recording saves it.
2. Every 10 min the backend (`cron/ringcentral-poll.js`) asks RingCentral for new recorded calls on your extension.
3. It looks up the other number in our leads (`phone` field). If it matches, it attaches that lead's email.
4. It hands the recording to Fireflies (`uploadAudio`). Fireflies transcribes and summarizes it.
5. The existing Fireflies poll stores it, matches the prospect, and drafts the follow-up. With `CALL_RECAP_EMAIL` set, it also emails you a recap (what happened, what you need to do, the draft).

There's no new transcription bill: Fireflies does the work on the plan you already pay for.

## Option A first: Fireflies' own RingCentral connector (5 min, no keys)

Fireflies > Integrations > RingCentral > Connect > sign in to RingCentral > Save. Make one test call.
- If it shows up in Fireflies, it flows through our pipeline already. Done.
- The catch: Fireflies only matches phone numbers to contacts through Salesforce, HubSpot, or Zoho, not Nutshell. So these calls usually have no prospect email, and no follow-up draft gets written. Our Option B matches against our own leads.
- **Don't run A and B together**, or each call gets transcribed twice.

## Option B: our backend (built, needs keys)

### 1. Turn on auto call recording (RingCentral Admin Portal)
Your user > Call Handling & Forwarding > Call Recording (or Phone System > Auto Call Recording). Turn it on for inbound and outbound. Turn the announcement on too: Texas is one-party consent, but callers in CA, FL, and some other states need to hear it.

### 2. Create the app (developers.ringcentral.com > Console > Register App)
- Type: **REST API App**, auth: **JWT auth flow**, server only (no UI)
- Scopes: **Read Call Log**, **Read Call Recording**. (Skip WebhookSubscriptions: we poll.)
- Access: private, your account only

### 3. Make a JWT
Console > your profile > Credentials > Create JWT, tied to this app. Copy it right away, since it's shown once.

### 4. Production
New apps start in sandbox. If the app page has an "Apply for Production" button, use it. Older rules asked for a few successful sandbox calls first: put the sandbox keys plus `RINGCENTRAL_SERVER=https://platform.devtest.ringcentral.com` in `.env`, hit the status URL below a few times, then apply.

### 5. Add to the VPS `.env` (`/root/story-group-gtm/backend/.env`)
```
RINGCENTRAL_CLIENT_ID=...
RINGCENTRAL_CLIENT_SECRET=...
RINGCENTRAL_JWT=...
CALL_RECAP_EMAIL=vincent@storygroup.io      # optional: recap email per phone call
# RINGCENTRAL_MIN_SECONDS=60                # skip calls shorter than this
# CALL_RECAP_ALL=true                       # recap Zoom/Meet calls too
```
Then `pm2 restart gtm-engine`.

### 6. Test
```
curl http://localhost:3001/api/ringcentral/status          # on the VPS: your extension + recorded calls in last 7 days
curl -X POST http://localhost:3001/api/trigger/ringcentral-poll
curl -X POST http://localhost:3001/api/trigger/fireflies-poll   # after Fireflies finishes (a few min)
```
`recorded_calls_last_7_days: 0` means recording isn't on yet.

## Not verified yet
- Live test 10/21/2026: JWT works on production (ext 10103), 2 recorded calls went through Fireflies and came back summarized. Fireflies strips colons from titles, so phone calls are detected by the "RingCentral call" prefix.
- Fireflies upload limits on our plan (size and count per month).
- The phone match only finds leads whose `phone` was saved by enrichment. Prospects who booked from LinkedIn or Calendly with no stored phone come through as numbers only, so they get a summary but no draft.

## Later, if wanted
RingSense (RingCentral's AI add-on, about $60/user/mo per third-party sources) returns its own transcript, summary, and next steps at `GET /ai/ringsense/v1/public/accounts/~/domains/pbx/records/{sourceRecordId}/insights`. Not needed while Fireflies does the job.
