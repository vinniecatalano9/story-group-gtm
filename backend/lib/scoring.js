const C_SUITE_TITLES = /\b(CEO|CFO|CTO|COO|CMO|CRO|Chief|President|Founder|Owner|Managing Director|VP|Vice President|Director|Head of)\b/i;

const SIGNAL_SCORES = {
  funding_growth: 30,
  competitor_pr: 25,
  leadership_change: 25,
  product_launch: 20,
  negative_press: 20,
  hiring_comms: 30,
  active_ad_spend: 20,
  industry_event: 15,
  content_gap: 10,
  no_signal: 0,
};

const STRENGTH_MULTIPLIER = {
  hot: 1.5,
  warm: 1.0,
  cold: 0.5,
};

function scoreLead(lead) {
  // Base score
  let base = 0;
  if (lead.email) base += 10;
  if (lead.linkedin_url) base += 5;
  if (lead.role_title && C_SUITE_TITLES.test(lead.role_title)) base += 15;
  if (lead.company_domain) base += 5;

  // Signal score
  const signalBase = SIGNAL_SCORES[lead.signal_type] || 0;
  const multiplier = STRENGTH_MULTIPLIER[lead.signal_strength] || 1.0;
  const signalScore = signalBase * multiplier;

  const total = Math.round(base + signalScore);

  // Route to tier
  let tier;
  if (!lead.email) {
    tier = 'manual_review';
  } else if (total >= 60) {
    tier = 'priority';
  } else if (total >= 30) {
    tier = 'standard';
  } else {
    tier = 'nurture';
  }

  return { score: total, tier };
}

module.exports = { scoreLead, SIGNAL_SCORES, STRENGTH_MULTIPLIER };
