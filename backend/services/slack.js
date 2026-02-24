const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK_URL;

async function notify(text, blocks = null) {
  if (!SLACK_WEBHOOK) {
    console.log('[slack] No webhook configured, skipping:', text);
    return;
  }
  try {
    const body = blocks ? { text, blocks } : { text };
    const res = await fetch(SLACK_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) console.error('[slack] Error:', res.status, await res.text());
  } catch (e) {
    console.error('[slack] Failed to send:', e.message);
  }
}

async function notifyNewReply({ email, company, classification, sentiment, summary, draftResponse }) {
  const emoji = {
    interested: ':fire:',
    not_interested: ':x:',
    ooo: ':palm_tree:',
    bounce: ':warning:',
    referral: ':handshake:',
  }[classification] || ':speech_balloon:';

  await notify(`${emoji} New reply from ${email}`, [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${emoji} *New Reply — ${classification.toUpperCase()}*\n*From:* ${email} (${company || 'Unknown'})\n*Sentiment:* ${sentiment}\n*Summary:* ${summary}`,
      },
    },
    ...(draftResponse ? [{
      type: 'section',
      text: { type: 'mrkdwn', text: `*Suggested Response:*\n>${draftResponse}` },
    }] : []),
    ...(classification === 'interested' ? [{
      type: 'section',
      text: { type: 'mrkdwn', text: `:calendar: <${process.env.CALENDLY_LINK}|Book a call>` },
    }] : []),
  ]);
}

async function notifyCleanup({ totalDeleted, campaigns }) {
  await notify(`:broom: Weekly Cleanup Complete\nDeleted ${totalDeleted} stale leads across ${campaigns} campaigns`);
}

async function notifyDashboard(stats) {
  const { ingested, enriched, emailed, replied, booked } = stats;
  const replyRate = emailed > 0 ? ((replied / emailed) * 100).toFixed(1) : '0';
  await notify(`:bar_chart: Weekly Pipeline Report\n• Ingested: ${ingested}\n• Enriched: ${enriched}\n• Emailed: ${emailed}\n• Replied: ${replied} (${replyRate}%)\n• Booked: ${booked}`);
}

module.exports = { notify, notifyNewReply, notifyCleanup, notifyDashboard };
