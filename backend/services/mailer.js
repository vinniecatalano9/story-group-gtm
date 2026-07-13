const nodemailer = require('nodemailer');

// Gmail SMTP via app password (Instantly API can't send fresh emails,
// and the Google service account has no domain-wide delegation).
// .env: SMTP_USER=vincent@storygroup.io, SMTP_PASS=<gmail app password>
const SMTP_HOST = () => process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = () => Number(process.env.SMTP_PORT || 465);
const SMTP_USER = () => process.env.SMTP_USER;
const SMTP_PASS = () => process.env.SMTP_PASS;

let _transport = null;
function getTransport() {
  if (_transport) return _transport;
  _transport = nodemailer.createTransport({
    host: SMTP_HOST(),
    port: SMTP_PORT(),
    secure: SMTP_PORT() === 465,
    auth: { user: SMTP_USER(), pass: SMTP_PASS() },
  });
  return _transport;
}

function isConfigured() {
  return !!(SMTP_USER() && SMTP_PASS());
}

async function sendMail({ to, cc, subject, html, text, fromName = 'Story Group GTM' }) {
  if (!isConfigured()) {
    console.warn('[mailer] SMTP_USER/SMTP_PASS not configured — email not sent');
    return null;
  }
  const info = await getTransport().sendMail({
    from: `"${fromName}" <${SMTP_USER()}>`,
    to: Array.isArray(to) ? to.join(', ') : to,
    ...(cc && cc.length ? { cc: Array.isArray(cc) ? cc.join(', ') : cc } : {}),
    subject,
    html,
    text,
  });
  console.log(`[mailer] Sent "${subject}" to ${Array.isArray(to) ? to.join(', ') : to} (${info.messageId})`);
  return info;
}

module.exports = { sendMail, isConfigured };
