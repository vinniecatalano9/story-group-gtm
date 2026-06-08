const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK_URL;

// Slack delivery disabled per Vincent — all GTM output lives on the Command tab.
// Kept as a no-op so existing callers (brief, reply alerts, dashboard) don't error.
async function notify(text, blocks = null) {
  return;
}

async function notifyNewReply({ email, company, classification, sentiment, summary, draftResponse, pastReplies = [] }) {
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
    ...(pastReplies.length > 0 ? [
      { type: 'divider' },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Previous Replies (${pastReplies.length}):*\n${pastReplies.map(r => {
            const date = r.created_at?.toDate ? r.created_at.toDate().toLocaleDateString() : 'unknown';
            const snippet = (r.reply_text || r.summary || '').substring(0, 120);
            return `• _${date}_ — ${r.classification || 'unknown'}: ${snippet}${snippet.length >= 120 ? '…' : ''}`;
          }).join('\n')}`,
        },
      },
    ] : []),
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

async function notifySentReply({ channel, email, contactName, messagePreview }) {
  const icon = channel === 'linkedin' ? ':briefcase:' : ':email:';
  const via = channel === 'linkedin' ? 'LinkedIn' : 'Email';
  const who = contactName || email;
  await notify(`${icon} Reply sent to ${who} via ${via}`, [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${icon} *Reply Sent via ${via}*\n*To:* ${who}${contactName && email ? ` (${email})` : ''}\n*Message:* ${messagePreview.substring(0, 200)}${messagePreview.length > 200 ? '…' : ''}`,
      },
    },
  ]);
}

module.exports = { notify, notifyNewReply, notifyCleanup, notifyDashboard, notifySentReply };
