const express = require('express');
const axios = require('axios');
const router = express.Router();

const INSTANTLY_BASE = 'https://api.instantly.ai/api/v2';

function authHeader() {
  const key = process.env.INSTANTLY_API_KEY;
  if (!key) throw new Error('INSTANTLY_API_KEY not set');
  return { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' };
}

function todayISO() { return new Date().toISOString().slice(0, 10); }

/**
 * GET /api/instantly/daily-stats
 *   ?date=YYYY-MM-DD   (defaults to today)
 *
 * Returns one row per campaign for that day, shaped for the daily tracker's
 * Cold Email tab:
 *   { date, campaign, emailsSent, openRate, positiveReplies, meetingsBooked, campaignId }
 */
router.get('/daily-stats', async (req, res) => {
  try {
    const date = req.query.date || todayISO();
    const r = await axios.get(`${INSTANTLY_BASE}/campaigns/analytics`, {
      params: { start_date: date, end_date: date },
      headers: authHeader()
    });

    const arr = Array.isArray(r.data) ? r.data : (r.data?.items || r.data?.campaigns || []);
    const items = arr.map(c => {
      const sent       = Number(c.emails_sent_count       || c.sent       || c.leads_emailed_count || 0);
      const opened     = Number(c.open_count              || c.opened     || c.unique_open_count   || 0);
      const positive   = Number(c.positive_reply_count    || c.positive_replies || 0);
      const meetings   = Number(c.meetings_count          || c.meetings_booked  || c.opportunity_count || 0);
      const openRate   = sent > 0 ? Math.round((opened / sent) * 1000) / 10 : 0;
      return {
        date,
        campaign: 'Instantly — ' + (c.campaign_name || c.name || ('Campaign ' + (c.id || c.campaign_id || '?'))),
        emailsSent: sent,
        openRate,
        positiveReplies: positive,
        meetingsBooked: meetings,
        campaignId: c.id || c.campaign_id || null
      };
    });

    res.json({ date, items });
  } catch (e) {
    res.status(500).json({ error: e.message, status: e.response?.status, body: e.response?.data });
  }
});

/**
 * GET /api/instantly/campaigns
 * Returns a lean list of campaigns for the tracker's Source dropdown.
 */
router.get('/campaigns', async (req, res) => {
  try {
    const r = await axios.get(`${INSTANTLY_BASE}/campaigns`, {
      params: { limit: 100 },
      headers: authHeader()
    });
    const arr = Array.isArray(r.data) ? r.data : (r.data?.items || r.data?.campaigns || []);
    const items = arr.map(c => ({
      id: c.id || c.campaign_id,
      name: c.name || c.campaign_name || ('Campaign ' + (c.id || '?'))
    }));
    res.json({ totalCount: items.length, items });
  } catch (e) {
    res.status(500).json({ error: e.message, status: e.response?.status, body: e.response?.data });
  }
});

module.exports = router;
