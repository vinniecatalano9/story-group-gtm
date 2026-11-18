/**
 * Mail provider check for cold email.
 *
 * Rule (Vincent, 2026-11-17): cold email goes only to addresses whose domain is hosted
 * on Google or Microsoft. Everything else (Proofpoint, Mimecast, Barracuda, Sophos,
 * small hosts, no MX) is never loaded into a cold email campaign. Those leads are
 * LinkedIn only.
 *
 * The rule table is a port of story-group-gtm-engine/email-cleaner/mx_provider.py.
 * Keep the two in sync.
 *
 * A lookup failure or a domain with no MX is NOT ok (fail closed).
 */
const dns = require('dns');

const OK_PROVIDERS = ['Google', 'Microsoft'];

// First rule with a needle found in any MX host wins. Order matters.
const RULES = [
  ['Google', ['google.com', 'googlemail.com']],
  ['Microsoft', ['outlook.com', 'office365', 'hotmail.com', 'microsoft']],
  ['Proofpoint', ['pphosted.com', 'ppe-hosted.com', 'proofpoint']],
  ['Mimecast', ['mimecast']],
  ['Barracuda', ['barracuda']],
  ['Cisco IronPort', ['iphmx.com']],
  ['Sophos', ['sophos']],
  ['Trend Micro', ['trendmicro']],
  ['Fortinet', ['fortimail']],
  ['Hornetsecurity', ['hornetsecurity', 'antispameurope']],
  ['AppRiver/Zix', ['arsmtp.com', 'zixmail', 'appriver']],
  ['GoDaddy', ['secureserver.net']],
  ['Zoho', ['zoho']],
  ['Rackspace', ['emailsrvr.com']],
  ['Intermedia', ['serverdata.net']],
  ['Yahoo/AOL', ['yahoodns', 'aol.com']],
  ['Apple iCloud', ['icloud.com']],
  ['Fastmail', ['messagingengine.com']],
  ['Proton', ['protonmail', 'proton.me']],
  ['Titan', ['titan.email']],
  ['Namecheap', ['privateemail.com', 'registrar-servers']],
  ['Cloudflare routing', ['mx.cloudflare.net']],
];

const NO_MX = 'no MX found';
const LOOKUP_FAILED = 'lookup failed';

// Config is read lazily so it can change at runtime.
const CACHE_HOURS = () => parseFloat(process.env.MX_CACHE_HOURS) || 24;
const FAIL_CACHE_MINUTES = () => parseFloat(process.env.MX_FAIL_CACHE_MINUTES) || 5;
const FALLBACK_DNS = () =>
  (process.env.MX_FALLBACK_DNS || '8.8.8.8,1.1.1.1').split(',').map(s => s.trim()).filter(Boolean);
const CONCURRENCY = () => parseInt(process.env.MX_LOOKUP_CONCURRENCY) || 10;

// domain -> { promise, expires }
const cache = new Map();

/** Classify a list of MX hostnames. Pure, no network. */
function classify(hosts) {
  const list = (hosts || []).map(h => String(h || '').toLowerCase().replace(/\.$/, '')).filter(Boolean);
  if (!list.length) return NO_MX;
  for (const [name, needles] of RULES) {
    if (list.some(h => needles.some(n => h.includes(n)))) return name;
  }
  return 'Other';
}

function isOkProvider(provider) {
  return OK_PROVIDERS.includes(provider);
}

function domainOf(email) {
  const s = String(email || '').trim().toLowerCase();
  const at = s.lastIndexOf('@');
  if (at < 1 || at === s.length - 1) return '';
  return s.slice(at + 1).replace(/\.$/, '');
}

function resolvers() {
  const opts = { timeout: 4000, tries: 2 };
  const system = new dns.promises.Resolver(opts);
  const out = [system];
  const servers = FALLBACK_DNS();
  if (servers.length) {
    try {
      const fallback = new dns.promises.Resolver(opts);
      fallback.setServers(servers);
      out.push(fallback);
    } catch (e) {
      console.warn('[mxProvider] Bad MX_FALLBACK_DNS, using the system resolver only:', e.message);
    }
  }
  return out;
}

/** MX hosts for a domain, best priority first. Tries the system resolver, then public DNS. */
async function resolveMxHosts(domain) {
  let failed = false;
  let error = '';
  for (const r of resolvers()) {
    try {
      const records = await r.resolveMx(domain);
      const hosts = (records || [])
        .slice()
        .sort((a, b) => a.priority - b.priority)
        .map(x => String(x.exchange || '').toLowerCase().replace(/\.$/, ''))
        .filter(Boolean); // a null MX ("0 .") means the domain takes no mail
      if (hosts.length) return { hosts, failed: false, error: '' };
    } catch (e) {
      // ENODATA / ENOTFOUND are real answers (no MX, no such domain). Anything else is a failed lookup.
      if (e.code !== 'ENODATA' && e.code !== 'ENOTFOUND') {
        failed = true;
        error = e.code || e.message;
      }
    }
  }
  return { hosts: [], failed, error };
}

async function lookup(domain) {
  const { hosts, failed, error } = await resolveMxHosts(domain);
  const provider = hosts.length ? classify(hosts) : failed ? LOOKUP_FAILED : NO_MX;
  const result = { domain, provider, mx: hosts[0] || '', ok: isOkProvider(provider) };
  if (failed && !hosts.length) result.error = error;
  return result;
}

/**
 * Provider for one domain. Cached in memory per domain.
 * Returns { domain, provider, mx, ok }. ok is true only for Google and Microsoft.
 */
async function checkDomain(domain) {
  const d = String(domain || '').trim().toLowerCase().replace(/\.$/, '');
  if (!d || !d.includes('.')) return { domain: d, provider: NO_MX, mx: '', ok: false };

  const hit = cache.get(d);
  if (hit && hit.expires > Date.now()) return hit.promise;

  const entry = { expires: Date.now() + CACHE_HOURS() * 3600000 };
  entry.promise = lookup(d)
    .catch(e => ({ domain: d, provider: LOOKUP_FAILED, mx: '', ok: false, error: e.message }))
    .then(result => {
      // A failed lookup may be a DNS blip, so only hold it briefly.
      if (result.provider === LOOKUP_FAILED) entry.expires = Date.now() + FAIL_CACHE_MINUTES() * 60000;
      return result;
    });
  cache.set(d, entry);
  return entry.promise;
}

/** Provider for one email address. An address with no usable domain is not ok. */
async function checkEmail(email) {
  const domain = domainOf(email);
  if (!domain) return { domain: '', provider: 'invalid email', mx: '', ok: false };
  return checkDomain(domain);
}

/** Check many emails. Returns a Map keyed by the lowercased, trimmed email. */
async function checkEmails(emails) {
  const keys = [...new Set((emails || []).map(e => String(e || '').trim().toLowerCase()))];
  const out = new Map();
  let next = 0;
  const worker = async () => {
    while (next < keys.length) {
      const key = keys[next++];
      out.set(key, await checkEmail(key));
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY(), keys.length) }, worker));
  return out;
}

function clearCache() {
  cache.clear();
}

module.exports = {
  OK_PROVIDERS, RULES, NO_MX, LOOKUP_FAILED,
  classify, isOkProvider, domainOf,
  checkDomain, checkEmail, checkEmails, clearCache,
};
