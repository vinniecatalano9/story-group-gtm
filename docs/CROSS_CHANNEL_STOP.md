# Cross-channel stop

Built 2026-11-17 for the video outbound test. A prospect who replies on one channel stops getting messages on the other.

- LinkedIn reply (HeyReach webhook) stops that person's email in the paired Instantly campaign.
- Email reply from a real person (Instantly webhook; never out of office or a bounce) stops that person in the paired HeyReach campaign.

Code: `backend/services/crossChannel.js`, `backend/routes/crosschannel.js`, hooks in `backend/routes/heyreach.js` and `backend/routes/replies.js`.

## Switches (backend `.env` on the VPS)

| Variable | Values | Now |
| --- | --- | --- |
| `CROSS_CHANNEL_STOP` | `off` (default), `shadow` (logs what it would stop, changes nothing), `live` | `shadow` |
| `CROSS_CHANNEL_PAIRS` | `instantlyCampaignId:heyreachCampaignId`, comma separated. Nothing outside a listed pair is ever touched. | the three video email campaigns (A, B1, B2), each paired with HeyReach 741119 |
| `CROSS_CHANNEL_ACCEPT` | `off` (default), `on`. Only records "connection accepted" on the link. Sends nothing. | `off` |
| `CROSS_CHANNEL_KEY` | Shared key the write routes need in the `x-cross-channel-key` header. | set |
| `CROSS_CHANNEL_HOLD_LIST_ID` | Optional Instantly lead list for stopped leads. Empty means live mode finds or makes "Cross-channel stop \| replied on LinkedIn". | empty |

## Go live

Only on Vincent's yes. On the VPS:

```bash
ssh root@187.77.19.152 "cd /root/story-group-gtm/backend && sed -i 's/^CROSS_CHANNEL_STOP=.*/CROSS_CHANNEL_STOP=live/' .env && pm2 restart gtm-engine"
```

Back to shadow: same command with `shadow`. Never `pm2 restart --update-env`.

Before going live, test one real stop in each direction with a lead you own (see "Not yet proven" below).

## How a stop works

- **Instantly** has no "pause one lead" call. The lead is moved out of the campaign into a holding lead list (`POST /leads/move` with the lead id, the source campaign and `limit: 1`). The record and its history are kept and it can be moved back in the Instantly UI. Nothing is deleted. A copy of the lead is saved on the link doc first (`instantly_snapshot`).
- **HeyReach**: `POST /campaign/StopLeadInCampaign` with the campaign id, the lead's member id and profile URL. The lead stays in the campaign, marked stopped.

## The link store

Firestore collection `channel_links`: one doc per person per pair (email, LinkedIn URL, name, company, both campaign ids). Without a link nothing can be stopped, so load the list before launch.

- From a CSV (writes only to Firestore): `node scripts/crosschannel-import.js <leads.csv> --dry`, then without `--dry`.
- By API: `POST /api/crosschannel/links` with `{ rows: [{ email, linkedinUrl, firstName, lastName, company }] }`.
- Automatically: `POST /api/heyreach/campaign/:id/push` saves a link for every lead that carries an `email`, when the campaign is in a pair.

**After the lead list or the campaign split changes, rebuild from the live lists** (run on the VPS, it needs both API keys; report only unless `--apply`):

```bash
node scripts/crosschannel-sync.js <leads.csv> --heyreach-campaign 741119 --apply
```

It reads who is really in each paired Instantly campaign and on the HeyReach campaign's list, points each link at the Instantly campaign that person is in, deletes links that no longer belong (after saving a backup in `/root/backups`), and marks `on_linkedin: false` for people who get the email but are not on that HeyReach list. For those people an email reply stops nothing and logs a `manual_check` row; a LinkedIn reply still stops their email. One HeyReach campaign can be paired with several Instantly campaigns: list each as its own pair.

Matching a LinkedIn reply to a link: profile URL first (lowercased, query and trailing slash stripped). If the URL misses (member-id export vs HeyReach's vanity URL), first plus last name plus company, and only when that points at exactly one person. Two candidates or a company mismatch means no action and a log row marked `manual_check`.

## Seeing what it did

Every decision is a row in the `logs` collection, type `cross_channel` (`mode`, `trigger_channel`, `action`, `outcome`, `who`, both campaign ids, `would` or `did`).

- `GET /api/crosschannel/status`: mode, pairs, link counts.
- `GET /api/crosschannel/log?limit=50`: newest rows (needs the key).
- `POST /api/crosschannel/simulate`: one shadow decision for a profile URL or an email. Never stops anything.
- `node scripts/crosschannel-replay.js`: runs both real webhook routes against an in-memory database and fake vendors and checks 22 cases. Run it after any change to these files.

## Not yet proven

- The Instantly move and the HeyReach stop are built from both vendors' current API docs and checked against fake vendors. Neither has run against the real services, because both campaigns are empty drafts. Prove each once with a lead you own before `live`.
- The connection-accepted handler exists but HeyReach is not sending that event (no `CONNECTION_REQUEST_ACCEPTED` webhook is registered) and nothing emails on accept.
