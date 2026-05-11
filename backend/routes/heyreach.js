const express = require('express');
const axios = require('axios');
const router = express.Router();

const HEYREACH_BASE = 'https://api.heyreach.io/api/public';

function headers() {
  const key = process.env.HEYREACH_API_KEY;
  if (!key) throw new Error('HEYREACH_API_KEY not set');
  return { 'X-API-KEY': key, 'Content-Type': 'application/json' };
}

function todayISO() { return new Date().toISOString().slice(0, 10); }

function isoDate(d) {
  const dt = new Date(d);
  if (isNaN(dt)) return null;
  return dt.toISOString();
}

router.get('/health', async (req, res) => {
  try {
    const r = await axios.get(`${HEYREACH_BASE}/auth/CheckApiKey`, { headers: headers() });
    res.json({ ok: true, status: r.status });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, status: e.response?.status });
  }
});

router.get('/accounts', async (req, res) => {
  try {
    const r = await axios.post(`${HEYREACH_BASE}/li_account/GetAll`, { offset: 0, limit: 100 }, { headers: headers() });
    const items = (r.data?.items || []).map(a => ({
      id: a.id,
      firstName: a.firstName,
      lastName: a.lastName,
      fullName: [a.firstName, a.lastName].filter(Boolean).join(' '),
      emailAddress: a.emailAddress,
      status: a.status,
      headline: a.headline
    }));
    res.json({ totalCount: r.data?.totalCount || 0, items });
  } catch (e) {
    res.status(500).json({ error: e.message, status: e.response?.status, body: e.response?.data });
  }
});

router.get('/campaigns', async (req, res) => {
  try {
    const r = await axios.post(`${HEYREACH_BASE}/campaign/GetAll`, { offset: 0, limit: 100 }, { headers: headers() });
    const items = (r.data?.items || []).map(c => ({
      id: c.id,
      name: c.name,
      status: c.status,
      createdAt: c.createdAt
    }));
    res.json({ totalCount: r.data?.totalCount || 0, items });
  } catch (e) {
    res.status(500).json({ error: e.message, status: e.response?.status, body: e.response?.data });
  }
});

/**
 * GET /api/heyreach/stats
 *   ?accountIds=1,2,3      (optional — defaults to all accounts)
 *   ?campaignIds=10,11     (optional — defaults to all campaigns)
 *   ?from=YYYY-MM-DD       (optional — defaults to today)
 *   ?to=YYYY-MM-DD         (optional — defaults to today)
 *
 * Returns the Heyreach stats payload plus a flattened summary tuned
 * for the daily tracker UI.
 */
router.get('/stats', async (req, res) => {
  try {
    let accountIds = req.query.accountIds
      ? String(req.query.accountIds).split(',').map(s => Number(s)).filter(Boolean)
      : [];
    let campaignIds = req.query.campaignIds
      ? String(req.query.campaignIds).split(',').map(s => Number(s)).filter(Boolean)
      : [];

    if (!accountIds.length) {
      const a = await axios.post(`${HEYREACH_BASE}/li_account/GetAll`, { offset: 0, limit: 100 }, { headers: headers() });
      accountIds = (a.data?.items || []).map(x => x.id);
    }
    if (!campaignIds.length) {
      const c = await axios.post(`${HEYREACH_BASE}/campaign/GetAll`, { offset: 0, limit: 100 }, { headers: headers() });
      campaignIds = (c.data?.items || []).map(x => x.id);
    }

    if (!accountIds.length) return res.json({ items: [], summary: {}, note: 'No LinkedIn sender accounts connected in Heyreach yet.' });
    if (!campaignIds.length) return res.json({ items: [], summary: {}, note: 'No campaigns in Heyreach yet.' });

    const from = req.query.from ? `${req.query.from}T00:00:00.000Z` : `${todayISO()}T00:00:00.000Z`;
    const to   = req.query.to   ? `${req.query.to}T23:59:59.999Z`   : `${todayISO()}T23:59:59.999Z`;

    const body = {
      accountIds: accountIds,
      campaignIds: campaignIds,
      startDate: from,
      endDate: to
    };

    const r = await axios.post(`${HEYREACH_BASE}/stats/GetOverallStats`, body, { headers: headers() });
    const data = r.data || {};

    const summary = {
      requestsSent:     data.totalSentConnections      || data.connectionRequestsSent || 0,
      requestsAccepted: data.totalAcceptedConnections  || data.connectionsAccepted   || 0,
      inmailsSent:      data.totalInMailsSent          || data.inMailsSent           || 0,
      positiveReplies:  data.totalPositiveReplies      || data.positiveReplies       || 0,
      normalReplies:    (data.totalReplies || data.replies || 0) - (data.totalPositiveReplies || data.positiveReplies || 0),
      meetingsBooked:   data.totalMeetingsBooked       || data.meetingsBooked        || 0
    };
    if (summary.normalReplies < 0) summary.normalReplies = 0;

    res.json({ from, to, accountIds, campaignIds, summary, raw: data });
  } catch (e) {
    res.status(500).json({ error: e.message, status: e.response?.status, body: e.response?.data });
  }
});

/**
 * GET /api/heyreach/stats/per-account
 *   ?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Fans out one stats call per account so the tracker can pre-fill a row per sender.
 */
router.get('/stats/per-account', async (req, res) => {
  try {
    const a = await axios.post(`${HEYREACH_BASE}/li_account/GetAll`, { offset: 0, limit: 100 }, { headers: headers() });
    const accounts = a.data?.items || [];
    if (!accounts.length) return res.json({ items: [], note: 'No LinkedIn sender accounts connected in Heyreach yet.' });

    const c = await axios.post(`${HEYREACH_BASE}/campaign/GetAll`, { offset: 0, limit: 100 }, { headers: headers() });
    const campaignIds = (c.data?.items || []).map(x => x.id);
    if (!campaignIds.length) return res.json({ items: accounts.map(acc => ({
      id: acc.id, fullName: [acc.firstName, acc.lastName].filter(Boolean).join(' '), summary: null
    })), note: 'No campaigns in Heyreach yet.' });

    const from = req.query.from ? `${req.query.from}T00:00:00.000Z` : `${todayISO()}T00:00:00.000Z`;
    const to   = req.query.to   ? `${req.query.to}T23:59:59.999Z`   : `${todayISO()}T23:59:59.999Z`;

    const items = await Promise.all(accounts.map(async (acc) => {
      try {
        const r = await axios.post(`${HEYREACH_BASE}/stats/GetOverallStats`, {
          accountIds: [acc.id], campaignIds, startDate: from, endDate: to
        }, { headers: headers() });
        const d = r.data || {};
        return {
          id: acc.id,
          fullName: [acc.firstName, acc.lastName].filter(Boolean).join(' '),
          summary: {
            requestsSent:     d.totalSentConnections      || d.connectionRequestsSent || 0,
            requestsAccepted: d.totalAcceptedConnections  || d.connectionsAccepted   || 0,
            inmailsSent:      d.totalInMailsSent          || d.inMailsSent           || 0,
            positiveReplies:  d.totalPositiveReplies      || d.positiveReplies       || 0,
            normalReplies:    Math.max(0, (d.totalReplies || d.replies || 0) - (d.totalPositiveReplies || d.positiveReplies || 0)),
            meetingsBooked:   d.totalMeetingsBooked       || d.meetingsBooked        || 0
          }
        };
      } catch (e) {
        return { id: acc.id, fullName: [acc.firstName, acc.lastName].filter(Boolean).join(' '), error: e.message };
      }
    }));

    res.json({ from, to, items });
  } catch (e) {
    res.status(500).json({ error: e.message, status: e.response?.status, body: e.response?.data });
  }
});

module.exports = router;
