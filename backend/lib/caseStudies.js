// lib/caseStudies.js
//
// The 40 case studies from the PR knowledge base, matched to a prospect by
// sector so a reply can cite a real result instead of reaching for the generic
// "coverage across top-tier business networks" line.
//
// The binary rule from the knowledge base applies and is repeated in the
// prompt: cite a real case with a real number, or use no proof point at all.
// A vague proof point is worse than none, because it invites the follow-up
// question we can't answer.
//
// Source of truth is the CASES array in frontend/public/pr-mastery/index.html.
// Regenerate data/case-studies.json from it with scripts/sync-case-studies.js
// if that file changes.

const CASES = require('../data/case-studies.json');

// Words a prospect's company name, headline or reply might contain, mapped to
// the industry label used in the knowledge base.
const SECTOR_HINTS = [
  [/\b(construction|contractor|builder|roofing|hvac|plumb\w*|electric(al)?)\b/i, 'CONSTRUCTION & TRADES'],
  [/\b(home services|remodel\w*|landscap\w*|restoration)\b/i, 'HOME SERVICES & TRADES'],
  [/\b(pharma|biotech|life scien|clinical|drug|therapeutic)\b/i, 'BIOTECH & LIFE SCIENCES'],
  // Independent practices name themselves by specialty plus an entity suffix
  // ("Clover Podiatry PLLC", "Emergency Medical Associates, P.C."), which the
  // generic healthcare pattern below never caught.
  // \w* not \b on the tail: "podiat" must match "Podiatry", and a trailing \b
  // requires a word boundary straight after the prefix, so it never fires.
  [/\b(?:dental|dentist\w*\w*|orthodont\w*\w*|medical practice|clinic\w*|podiat\w*|dermatol\w*|orthoped\w*|cardiol\w*|pediatr\w*|obgyn|ophthalm\w*|chiroprac\w*|surgic\w*|surgery)/i, 'DENTAL & MEDICAL PRACTICES'],
  [/\b(hospital|health\w*|physician|patient|medical|emergency|urgent care|md\b|dr\.)\b/i, 'HEALTHCARE & PHARMACEUTICALS'],
  [/\b(chief medical|cmo of|nurse|clinician|care team|health leadership)\b/i, 'HEALTHCARE LEADERSHIP'],
  [/\b(?:therap\w*|counsel\w*|psycholog\w*|psychiatr\w*|behavioral health|mental health)/i, 'HEALTHCARE LEADERSHIP'],
  [/\b(senior living|assisted living|long.term care|memory care)\b/i, 'SENIOR LIVING & LONG-TERM CARE'],
  [/\b(vet|veterinary|animal health)\b/i, 'VETERINARY & ANIMAL HEALTH'],
  [/\b(bank|lending|mortgage|credit union|fintech|payments)\b/i, 'FINANCIAL SERVICES & BANKING'],
  [/\b(wealth|financial advisor|ria|advisory|portfolio manag)\b/i, 'WEALTH MANAGEMENT & FINANCIAL ADVISORY'],
  [/\b(private equity|venture\w*|vc|lp|fund|capital)\b/i, 'PRIVATE EQUITY & VENTURE CAPITAL'],
  [/\b(insurance|underwrit\w*|actuar\w*|broker of record)\b/i, 'INSURANCE'],
  [/\b(accounting|cpa|audit|tax firm)\b/i, 'ACCOUNTING & PROFESSIONAL FIRMS'],
  [/\b(law firm|attorney|litigat\w*|counsel|legal)\b/i, 'LEGAL & LAW FIRMS'],
  [/\b(saas|b2b software|platform|api|devtool)\b/i, 'SAAS & B2B TECHNOLOGY'],
  [/\b(software|tech|ai|machine learning|data)\b/i, 'TECHNOLOGY & SAAS'],
  [/\b(cyber|infosec|security|it services|msp)\b/i, 'CYBERSECURITY & IT SERVICES'],
  [/\b(ecommerce|e-commerce|dtc|consumer product|cpg|retail brand)\b/i, 'E-COMMERCE & CONSUMER PRODUCTS'],
  [/\b(retail|store|merchandis\w*)\b/i, 'RETAIL & E-COMMERCE'],
  [/\b(manufactur\w*|industrial|factory|fabricat\w*)\b/i, 'MANUFACTURING & INDUSTRIAL'],
  [/\b(logistics|supply chain|freight|3pl|warehous\w*)\b/i, 'LOGISTICS & SUPPLY CHAIN'],
  [/\b(transport\w*|trucking|fleet|shipping)\b/i, 'TRANSPORTATION & LOGISTICS'],
  [/\b(aerospace|aviation|aircraft|space)\b/i, 'AEROSPACE & AVIATION'],
  [/\b(defense|govcon|federal contract|darpa|dod)\b/i, 'DEFENSE & GOVERNMENT CONTRACTING'],
  [/\b(energy|utility|solar|oil|gas|renewable|grid)\b/i, 'ENERGY & UTILITIES'],
  [/\b(commercial real estate|cre|brokerage|tenant rep)\b/i, 'COMMERCIAL REAL ESTATE BROKERAGE'],
  [/\b(real estate|realty|property (management|development)|land development|homebuilder)\b/i, 'REAL ESTATE & DEVELOPMENT'],
  [/\b(architect\w*|design studio|interior design)\b/i, 'ARCHITECTURE & DESIGN'],
  [/\b(franchise|multi.unit|multi.location)\b/i, 'FRANCHISE & MULTI-UNIT OPERATIONS'],
  [/\b(staffing|recruit\w*|talent|headhunt)\b/i, 'STAFFING & RECRUITING'],
  [/\b(consult\w*|advisory firm|professional services|agency)\b/i, 'PROFESSIONAL SERVICES & CONSULTING'],
  [/\b(nonprofit|non-profit|foundation|charit\w*|advocacy\w*|501)\b/i, 'NONPROFIT & ADVOCACY'],
  [/\b(church|ministry|faith|religio\w*|diocese)\b/i, 'FAITH-BASED & RELIGIOUS ORGANIZATIONS'],
  [/\b(school|university|college|education|edtech|academy)\b/i, 'EDUCATION & HIGHER LEARNING'],
  [/\b(hotel|resort|hospitality|tourism|travel)\b/i, 'HOSPITALITY & TOURISM'],
  [/\b(restaurant|food|beverage|agricultur\w*|farm)\b/i, 'AGRICULTURE & FOOD PRODUCTION'],
  [/\b(fitness|gym|wellness|nutrition|supplement)\b/i, 'FITNESS & WELLNESS BRANDS'],
  [/\b(sport|athlet\w*|entertainment|media brand|studio)\b/i, 'SPORTS & ENTERTAINMENT'],
  [/\b(cannabis|cbd|hemp|psychedelic\w*)\b/i, 'CANNABIS & EMERGING INDUSTRIES'],
  [/\b(auto|automotive|dealership|vehicle|ev)\b/i, 'AUTOMOTIVE'],
];

function detectSector(text) {
  const t = String(text || '');
  for (const [rx, label] of SECTOR_HINTS) if (rx.test(t)) return label;
  return null;
}

/**
 * Up to `limit` cases relevant to the prospect. Exact sector first; if nothing
 * matches we return an empty list rather than a random case, because an
 * irrelevant proof point reads worse than none.
 */
function matchCases({ company, headline, replyText, limit = 2 } = {}) {
  const sector = detectSector([company, headline, replyText].filter(Boolean).join(' '));
  if (!sector) return { sector: null, cases: [] };
  return { sector, cases: CASES.filter(c => c.industry === sector).slice(0, limit) };
}

/** Compact rendering for a prompt. */
function formatForPrompt(cases) {
  if (!cases.length) return '';
  return cases.map(c =>
    `- ${c.industry} — "${c.title}"\n  Situation: ${c.challenge}\n  Results: ${c.metrics.map(([k, v]) => `${k}: ${v}`).join(' | ')}`
  ).join('\n');
}

module.exports = { CASES, matchCases, detectSector, formatForPrompt };
