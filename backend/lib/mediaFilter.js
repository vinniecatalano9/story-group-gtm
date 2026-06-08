// lib/mediaFilter.js
//
// Lydia pitches REPORTERS via Instantly to place PR clients — that's the actual PR
// work, not sales prospecting. Their replies must be excluded from the GTM board,
// the funnel, and the ICP analysis or they distort everything. This identifies a
// journalist/media-outreach record by news-outlet email domain or journalist headline.

const MEDIA_DOMAINS = new Set([
  // wires / national
  'axios.com', 'reuters.com', 'apnews.com', 'ap.org', 'politico.com', 'thehill.com',
  'cqrollcall.com', 'rollcall.com', 'semafor.com', 'puck.news', 'theguardian.com', 'guardian.co.uk',
  'nytimes.com', 'wsj.com', 'washingtonpost.com', 'usatoday.com', 'latimes.com', 'bostonglobe.com',
  'newsweek.com', 'time.com', 'theatlantic.com', 'vox.com', 'wired.com', 'economist.com', 'ft.com',
  // broadcast
  'cnn.com', 'foxnews.com', 'foxbusiness.com', 'nbcnews.com', 'cbsnews.com', 'abcnews.go.com',
  'msnbc.com', 'npr.org', 'pbs.org', 'bbc.com', 'bbc.co.uk',
  // business / finance / tech
  'bloomberg.com', 'cnbc.com', 'marketwatch.com', 'barrons.com', 'forbes.com', 'fortune.com',
  'businessinsider.com', 'insider.com', 'inc.com', 'entrepreneur.com', 'fastcompany.com',
  'techcrunch.com', 'theinformation.com', 'venturebeat.com', 'theverge.com', 'protocol.com',
  'adage.com', 'adweek.com', 'prweek.com', 'prnewswire.com', 'businesswire.com',
]);

const JOURNO_KW = [
  'reporter', 'journalist', 'correspondent', 'staff writer', 'contributing writer',
  'columnist', 'news anchor', 'newsroom', 'editor-in-chief', 'managing editor',
  'senior editor', 'news editor', 'producer at', 'segment producer',
];

function domainOf(email) {
  const m = String(email || '').toLowerCase().trim().split('@');
  return m.length === 2 ? m[1] : '';
}

/**
 * True if this record is journalist/media outreach we should IGNORE in GTM analysis.
 * Pass any of: { email, headline, company }.
 */
function isMediaOutreach({ email, headline, company } = {}) {
  const d = domainOf(email);
  if (d && MEDIA_DOMAINS.has(d)) return true;
  const text = `${headline || ''} ${company || ''}`.toLowerCase();
  if (JOURNO_KW.some(k => text.includes(k))) return true;
  return false;
}

module.exports = { isMediaOutreach, MEDIA_DOMAINS };
