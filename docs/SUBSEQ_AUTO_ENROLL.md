# Reply follow-up auto-enroll

Built 2026-11-18. A lead who replies once and then goes quiet gets put into that campaign's reply follow-up sequence (Instantly calls it a subsequence) without anyone setting a label by hand.

Code: `backend/lib/subseqPolicy.js` (the mapping), `backend/services/subseqEnroll.js`, `backend/routes/subseqEnroll.js`, the hook in `backend/routes/replies.js`, the cron in `backend/server.js`, four helpers at the bottom of `backend/services/instantly.js`.

## Switches (backend `.env` on the VPS)

| Variable | Values | Now |
| --- | --- | --- |
| `SUBSEQ_AUTO_ENROLL` | `off` (default), `shadow` (logs "would enroll", changes nothing), `live` | `shadow` since 2026-11-18 |
| `SUBSEQ_ENROLL_METHOD` | `move` (default), `label`. Only read in live mode. | not set (`move`) |
| `SUBSEQ_PENDING_DAYS` | Days to wait for our answer before giving up. | not set (7) |
| `SUBSEQ_CHECKS_PER_RUN` | Leads checked per 5 minute run. Instantly's email list allows 20 calls a minute. | not set (6) |

## How it works

1. **Their reply arrives** (Instantly webhook, `POST /api/reply`). After the reply is classified, a pending decision is saved in Firestore `subseq_pending`: lead email, campaign, the reply's email id, the classification and the policy's pick. Nothing touches Instantly. One open decision per lead per campaign: a newer reply replaces the older one, a "not interested" or a referral cancels it, an out of office or a bounce is ignored.
2. **Our answer goes out.** Every 5 minutes a cron reads each pending lead's emails from Instantly (`GET /emails?lead=`, read only) and looks for an email we sent (`ue_type` 3) in the same thread, after their reply. Only then is anything decided. It does not matter how the answer was sent: the Reply Bot phone card, the Instantly inbox, or the API.
3. **The decision.** The policy picks the sequence, the campaign's own subsequence is found by name (`GET /subsequences?parent_campaign=`), and the lead is checked. In shadow the result is one log row. In live it is one enroll call.

No answer from us within 7 days: the decision expires and nothing is enrolled. A bump like "what did you think of my last note?" can never go out when no note was sent.

## The mapping (`backend/lib/subseqPolicy.js`)

Plain tables. Edit the file to change them.

- **Call Time Sent**: `interested`, `re_engage`, `times_rejected`.
- **Objection Followup**: `cost_question`, `cost_question_repeat`, `spec_demand`, `more_info`, `send_info`, `why_reach_out`, `guarantee`, `competence_test`, `evaluator`, `timing_objection`, `budget_cycle`, `question_other`.
- **Nothing**: `not_interested`, `referral`, `ooo`, `bounce`, `ghost_followup`, `other`, and any reply the classifier failed on.
- **The sent text gets the last word** (`REFINE_BY_SENT_TEXT`, on): if the answer we really sent has a clock time in it ("2pm", "10:30 am", "noon") the pick is Call Time Sent, otherwise Objection Followup. So a cost answer that also pitched times goes to Call Time Sent, and an "interested" answer edited into a question goes to Objection Followup. Quoted earlier emails are cut off before the check.

It works for any campaign that has subsequences with those two names (case, spaces and hyphens ignored, so "Objection Follow-Up" matches). A campaign with neither is logged as `no_subsequence` and left alone.

## What is skipped

Each skip is a log row with the reason.

- The cross-channel stop moved the lead out of the campaign (they replied on LinkedIn).
- The lead is no longer in the campaign.
- The lead is labeled Meeting Booked, Meeting Completed, Won, Not Interested, Wrong Person, Lost or No Show.
- The lead is already in the target subsequence.
- The subsequence is not active (paused or draft).

## Seeing what it did

Rows are in the `logs` collection, type `subseq_enroll`: `mode`, `outcome` (`would_enroll`, `enrolled`, `no_action`, `skipped`, `no_subsequence`, `already_enrolled`, `expired_no_answer`, `failed`), `lead_email`, `campaign_id`, `campaign_name`, `classification`, `subsequence`, `subsequence_id`, `reason`, and `would` or `did`.

- `GET /api/subseq-enroll/status`: mode, live method, and how many decisions are pending, logged, skipped.
- `GET /api/subseq-enroll/log?limit=50`: newest rows (needs the `x-cross-channel-key` header, same key as the cross-channel routes).
- `node scripts/test-subseq-enroll.js`: 84 checks against a fake Firestore and a fake Instantly. Run it after any change to these files.

## Go live

Only on Vincent's yes, and only after the real test below. On the VPS:

```bash
ssh root@187.77.19.152 "cd /root/story-group-gtm/backend && cp .env .env.bak-\$(date +%F)-presubseqlive && sed -i 's/^SUBSEQ_AUTO_ENROLL=.*/SUBSEQ_AUTO_ENROLL=live/' .env && pm2 restart gtm-engine"
```

Back to shadow (the off switch if anything looks wrong):

```bash
ssh root@187.77.19.152 "cd /root/story-group-gtm/backend && sed -i 's/^SUBSEQ_AUTO_ENROLL=.*/SUBSEQ_AUTO_ENROLL=shadow/' .env && pm2 restart gtm-engine"
```

Never `pm2 restart --update-env`.

Decisions logged while in shadow are finished. Going live does not go back and enroll them: it only acts on answers sent after the switch (and on decisions still pending at the switch).

## The live call

Checked against the Instantly API v2 spec on 2026-11-18. Two calls can start a subsequence:

- **`POST /leads/subsequence/move`** with `{ id: <lead id>, subsequence_id }`. This is the default (`SUBSEQ_ENROLL_METHOD=move`). It names one lead and one subsequence, so it does exactly what the log row says, and it leaves the lead's label alone (the Interested label is what reporting counts).
- **`POST /leads/update-interest-status`** with `{ lead_email, interest_value, campaign_id }` (`SUBSEQ_ENROLL_METHOD=label`). This sets the label the subsequence is triggered by (read from the subsequence's own `conditions.crm_status`: 51 and 52 on the video campaigns) and lets Instantly start it, the same thing a person does by hand today. The spec says an explicit label change can also complete the lead in the campaign, create or update an opportunity and fire other automations, and it replaces the Interested label. That is more side effects than wanted, so it is the fallback.

The older `addLeadToSubsequence` (`POST /subsequences/entries`) and `updateLeadInterestStatus` (`PATCH /leads`) in `services/instantly.js` use paths that are not in the spec. This feature does not use them.

One try per enroll, never retried. A failed call is logged with `manual_check` and the label then has to be set by hand.

## Proven, and not yet proven

- **Sent-answer detection: proven on real threads, read only, 2026-11-18.** A reply in video campaign A arrived at 14:54 UTC, the answer went out from the phone card at 15:07, and `GET /emails?lead=` showed both in the same `thread_id`: the reply as `ue_type` 2 with the same id as the webhook's `email_id`, the answer as `ue_type` 3. Answers typed in the Instantly inbox back in July show up as `ue_type` 3 with a thread id too.
- **Instantly's `email_sent` webhook is not used.** It exists (`GET /webhooks/event-types`), but only `reply_received` is registered, and whether it fires for a hand-typed inbox reply could not be checked without registering a new webhook. The email list is the source of truth instead.
- **Subsequence lookup by name: proven, read only.** Campaign A returns both subsequences with their trigger labels.
- **Neither enroll call has run against Instantly.** The test covers the request shape only. Before going live: a scratch draft campaign with a scratch subsequence and one fake lead, run the move call on it, confirm the lead lands in the subsequence, then delete the scratch campaign. That test needs Vincent's yes.
- **Not known yet:** whether Instantly drops a lead out of a subsequence when they reply again. If it does not, a lead who answers a follow-up keeps getting the rest of them until someone removes them (`POST /leads/subsequence/remove`). Check it in the same scratch test.
