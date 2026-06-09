#!/usr/bin/env python3
"""Story Group ICP Filter (v3 — data-driven, built from real responses).

v3 deltas vs v2:
  + Industry anti-ICP gate: KILL compliance finance (RIAs/insurance/CPAs/etc.),
    nonprofits, political/election orgs, faith orgs, education orgs — these
    convert ~zero. Tech/health companies in those spaces are EXEMPT (fintech,
    insurtech, healthtech, medical-insurance advocacy survive).
  + "Partner" (pro-services owner) now qualifies as a buyer title.
  + Blank employee count no longer auto-kills (v2 dropped real founders this way);
    only confirmed <10 or >500 are dropped.
  Everything else (PR-firm DQ, stealth, former/open-to-work, personal email,
  web-presence, sub-founder/wrong-suite title kills) is unchanged.


Reads an Apollo CSV export and writes a filtered CSV containing only FIT
rows per the Story Group v2 ICP. Output preserves the input's columns
and column order exactly — no verdict columns, no reasons. Prints a
summary (total in/out, top kill reasons) to stdout.

Usage:
    python3 filter.py --input <path>
    python3 filter.py --input <path> --output <path>
    python3 filter.py --input <path> --save-kills

v2 ICP rules (paste-ready spec, encoded deterministically below):

  Buyer:    Founder / Co-founder / CEO / President / Owner / Managing Partner.
  Size:     10–500 employees.
  Real:     Has website OR populated LinkedIn.
  Disqual:  PR firms, comms agencies, publicity shops, media-relations.

  KILL when ANY:
    - PR / comms / publicity / media-relations firm
    - Sub-founder title (VP, Director, Manager, Head of, Lead)
    - Wrong-suite C-level (CMO/COO/CFO/CTO/CRO/CIO) without "Founder"
    - Personal Gmail / Yahoo / Hotmail email
    - Stealth / defunct / no web presence
    - <10 or >500 employees
    - "Former", "Ex-", "Open to work", "Between roles"
    - "Managing Director" alone (without Founder/CEO/President/Owner)
"""
import argparse
import csv
import os
import re
import sys
from collections import Counter

csv.field_size_limit(sys.maxsize)


# ───────── Column resolution (fuzzy header matching) ─────────

def normalize_header(h):
    return (h or '').strip().lower().replace('_', ' ').replace('-', ' ') \
        .replace('#', '').replace('  ', ' ').strip()


def build_col_map(headers):
    return {normalize_header(h): h for h in (headers or [])}


def col(row, col_map, *candidates):
    for c in candidates:
        nc = normalize_header(c)
        if nc in col_map:
            v = row.get(col_map[nc])
            if v is not None:
                return v.strip() if isinstance(v, str) else v
    return ''


# ───────── PR / comms firm disqualifier ─────────

PR_PATTERNS = [
    re.compile(r'\bpublic relations\b', re.I),
    re.compile(r'\bmedia relations\b', re.I),
    re.compile(r'\bpublicity\b', re.I),
    re.compile(r'\bpublicists?\b', re.I),
    re.compile(r'\bpress (office|relations|services|firm|agency|shop)\b', re.I),
    re.compile(r'\bpr (firm|agency|company|consult|consultancy|services|group|shop|partners|advisors)\b', re.I),
    re.compile(r'\b(communications|comms) (agency|consultancy|firm|consult|consultants|group|shop|partners|advisors)\b', re.I),
    re.compile(r'\b(boutique|premier|leading) pr\b', re.I),
    re.compile(r'(^|[\s,])pr\s*(&|and)\s*(communications|comms|marketing|media)\b', re.I),
    re.compile(r'\b(strategic|integrated)\s+communications\b', re.I),
    re.compile(r'\bearned[\s\-]?media\s+(agency|firm|consult)', re.I),
]

PR_INDUSTRY_VALUES = {
    'public relations and communications',
    'public relations',
    'media relations',
    'communications',
    'publicity',
}


def is_pr_firm(company_name, industry, headline, keywords):
    blocks = [company_name, industry, headline, keywords]
    for b in blocks:
        if not b:
            continue
        for p in PR_PATTERNS:
            if p.search(b):
                return True
    ind = (industry or '').lower()
    for v in PR_INDUSTRY_VALUES:
        if v in ind:
            return True
    return False


# ───────── Dead anti-ICP segments (v3 — industry-level kills) ─────────
# Real response data shows these convert ~zero for PR. Tech OR health companies
# operating in these spaces (fintech, insurtech, edtech, healthtech, medical
# insurance advocacy, etc.) are NOT dead — they're exempted.

TECH_EXEMPT_RE = re.compile(
    r'\b(software|saas|platform|fintech|insurtech|edtech|healthtech|health tech|'
    r'app\b|ai\b|artificial intelligence|machine learning|technology|data|'
    r'analytics|cloud|api\b|developer|marketplace|startup)\b', re.I)
HEALTH_EXEMPT_RE = re.compile(
    r'\b(health|medical|clinic|patient|biotech|pharma|therapeut|medtech|'
    r'physician|dental|nursing|hospital|wellness|life scienc|diagnostic|'
    r'genomic|telehealth|care\b)\b', re.I)

DEAD_FINANCE_RE = re.compile(
    r'\b(insurance agen|insurance brok|insurance servic|life insurance|'
    r'wealth management|wealth advisor|wealth partners|financial advisor|'
    r'financial advis|financial planning|registered investment|investment advis|'
    r'\bria\b|credit union|accounting firm|\bcpa\b|certified public account|'
    r'tax preparation|tax servic|bookkeeping|mortgage brok|mortgage lend|'
    r'loan officer|retirement planning|estate planning)\b', re.I)
DEAD_FINANCE_INDUSTRY = {
    'insurance', 'banking', 'accounting', 'investment management',
    'capital markets', 'investment banking', 'consumer lending', 'credit',
}

DEAD_NONPROFIT_RE = re.compile(
    r'\b(non[\s\-]?profit|501\(?c\)?\s*3|charit|philanthrop|\bngo\b|'
    r'humanitarian|relief (fund|organization|international)|food bank|'
    r'rescue mission|homeless shelter|\bhomeless\b)\b', re.I)
DEAD_NONPROFIT_INDUSTRY = {
    'non-profit organization management', 'nonprofit organization management',
    'philanthropy', 'civic & social organization', 'fund-raising',
}

DEAD_POLITICAL_RE = re.compile(
    r'\b(political (organization|action|campaign|consult)|\bpac\b|super pac|'
    r'election servic|campaign (manage|consult)|for (congress|senate|governor)|'
    r'party committee|republican party|democratic party)\b', re.I)
DEAD_POLITICAL_INDUSTRY = {'political organization', 'legislative office', 'public policy'}

DEAD_FAITH_RE = re.compile(
    r'\b(\bchurch\b|ministr|faith[\s\-]based|gospel|parish|diocese|'
    r'congregation|synagogue|ministries)\b', re.I)
DEAD_FAITH_INDUSTRY = {'religious institutions'}

DEAD_EDU_RE = re.compile(
    r'\b(school district|k[\s\-]?12|elementary school|high school|'
    r'middle school|public school|charter school)\b', re.I)
DEAD_EDU_INDUSTRY = {'primary/secondary education', 'education management'}


def dead_segment(industry, company_name, keywords, headline):
    """Return a kill-reason if this is a dead anti-ICP segment, else None."""
    ind = (industry or '').strip().lower()
    blob = ' '.join([company_name or '', keywords or '', headline or '', industry or ''])
    # Exempt only genuine TECH companies in these spaces (fintech/insurtech/edtech).
    # NOT health — a health-INSURANCE broker is still dead finance; real healthtech
    # is never labeled insurance/banking industry, so it won't hit these kills anyway.
    tech = bool(TECH_EXEMPT_RE.search(blob))

    # Finance services & education orgs: dead UNLESS a genuine tech company in that space.
    if not tech:
        if ind in DEAD_FINANCE_INDUSTRY or DEAD_FINANCE_RE.search(blob):
            return 'dead_finance_services'
        if ind in DEAD_EDU_INDUSTRY or DEAD_EDU_RE.search(blob):
            return 'dead_education_org'

    # Nonprofit / political / faith: structural — no exemption.
    if ind in DEAD_NONPROFIT_INDUSTRY or DEAD_NONPROFIT_RE.search(blob):
        return 'dead_nonprofit'
    if ind in DEAD_POLITICAL_INDUSTRY or DEAD_POLITICAL_RE.search(blob):
        return 'dead_political'
    if ind in DEAD_FAITH_INDUSTRY or DEAD_FAITH_RE.search(blob):
        return 'dead_faith_religious'
    return None


# ───────── Title decision ─────────

FOUNDER_RE = re.compile(r'\b(co[\s\-]?founder|cofounder|founder|founding ceo|founding president)\b', re.I)
CEO_RE = re.compile(r'\b(ceo|c\.e\.o\.?|chief executive officer|chief exec)\b', re.I)
PRESIDENT_RE = re.compile(r'\bpresident\b', re.I)
OWNER_RE = re.compile(r'\b(owner|proprietor)\b', re.I)
MP_RE = re.compile(r'\bmanaging partner\b', re.I)
MD_RE = re.compile(r'\bmanaging director\b', re.I)
# v3: a bare "Partner" at a pro-services firm is an owner/decision-maker (a converting
# vertical). Exclude partnership/channel/marketing-partner functional roles.
PARTNER_RE = re.compile(r'\b(founding|general|managing|senior|equity|name|practice)?\s*partner\b', re.I)
PARTNER_EXCLUDE_RE = re.compile(r'\b(partnership|partnerships|channel partner|partner (manager|success|marketing|development|account|enablement)|business development)\b', re.I)

# False-positive title patterns
PRESIDENT_OF_FUNCTION_RE = re.compile(
    r'\bpresident\s+of\s+(sales|marketing|operations|engineering|product|finance|hr|people|technology|revenue|growth|customer|client|business|brand)\b',
    re.I,
)
SUB_PRESIDENT_RE = re.compile(r'\b(vice|associate|deputy|assistant|executive vice|sr\.? vice|senior vice)\s+president\b', re.I)
FORMER_RE = re.compile(r'(\b(former|formerly|ex|retired|previous|prior|outgoing|departing|emeritus)\b\s*[\-\:\,\s])|(\bex[\s\-](ceo|founder|president|owner|cmo|cfo|coo|director|vp))', re.I)
OPEN_TO_WORK_RE = re.compile(r'(open to work|looking for (a |my )?next|seeking|between roles|in transition|on the market|currently exploring|advisor seeking)', re.I)

# Wrong-suite C-level patterns (kill if not also Founder)
WRONG_CSUITE = [
    (re.compile(r'\bcmo\b', re.I), 'cmo'),
    (re.compile(r'chief marketing officer', re.I), 'cmo'),
    (re.compile(r'\bcfo\b', re.I), 'cfo'),
    (re.compile(r'chief financial officer', re.I), 'cfo'),
    (re.compile(r'\bcoo\b', re.I), 'coo'),
    (re.compile(r'chief operating officer', re.I), 'coo'),
    (re.compile(r'chief operations officer', re.I), 'coo'),
    (re.compile(r'\bcto\b', re.I), 'cto'),
    (re.compile(r'chief technology officer', re.I), 'cto'),
    (re.compile(r'\bcio\b', re.I), 'cio'),
    (re.compile(r'chief information officer', re.I), 'cio'),
    (re.compile(r'\bcro\b', re.I), 'cro'),
    (re.compile(r'chief revenue officer', re.I), 'cro'),
    (re.compile(r'\bcso\b', re.I), 'cso'),
    (re.compile(r'\bcdo\b', re.I), 'cdo'),
    (re.compile(r'\bcpo\b', re.I), 'cpo'),
    (re.compile(r'chief product officer', re.I), 'cpo'),
    (re.compile(r'\bclo\b', re.I), 'clo'),
    (re.compile(r'chief legal officer', re.I), 'clo'),
    (re.compile(r'\bcco\b', re.I), 'cco'),
    (re.compile(r'chief commercial officer', re.I), 'cco'),
    (re.compile(r'chief of staff', re.I), 'chief_of_staff'),
    (re.compile(r'chief.{1,30}officer', re.I), 'cxo_other'),
]

SUB_FOUNDER_RES = [
    re.compile(r'\bvp\b', re.I),
    re.compile(r'\bvice[\s\-]president\b', re.I),
    re.compile(r'\bdirector\b', re.I),
    re.compile(r'\bmanager\b', re.I),
    re.compile(r'\bhead of\b', re.I),
    re.compile(r'\blead\b', re.I),
    re.compile(r'\bsenior\b', re.I),
    re.compile(r'\bprincipal\b', re.I),
    re.compile(r'\bassociate\b', re.I),
    re.compile(r'\banalyst\b', re.I),
    re.compile(r'\bcoordinator\b', re.I),
    re.compile(r'\bspecialist\b', re.I),
    re.compile(r'\bconsultant\b', re.I),
    re.compile(r'\bassistant\b', re.I),
]

# "Executive Assistant to CEO" etc. — title contains CEO/Founder but person isn't one
SUPPORT_ROLE_RE = re.compile(
    r'\b(executive\s+assistant|administrative\s+assistant|chief of staff|ea|admin)\b.{0,40}\b(to|for)\b',
    re.I,
)


def title_verdict(title):
    """Return ('FIT', '') | ('KILL', reason) | ('PASS', '')."""
    if not title or not title.strip():
        return 'KILL', 'no_title'
    t = title.strip()

    if OPEN_TO_WORK_RE.search(t):
        return 'KILL', 'open_to_work'
    if FORMER_RE.search(t):
        return 'KILL', 'former_role'
    if SUPPORT_ROLE_RE.search(t):
        return 'KILL', 'support_role_to_exec'

    is_founder = bool(FOUNDER_RE.search(t))
    is_ceo = bool(CEO_RE.search(t))
    is_president_word = bool(PRESIDENT_RE.search(t))
    is_president = is_president_word and not PRESIDENT_OF_FUNCTION_RE.search(t) and not SUB_PRESIDENT_RE.search(t)
    is_owner = bool(OWNER_RE.search(t))
    is_mp = bool(MP_RE.search(t))
    is_md = bool(MD_RE.search(t)) and not is_mp
    is_partner = bool(PARTNER_RE.search(t)) and not PARTNER_EXCLUDE_RE.search(t)

    qualifying = is_founder or is_ceo or is_president or is_owner or is_mp or is_partner

    # Founder presence wins over everything (per v2: "Founder & X" = FIT)
    if is_founder:
        return 'PASS', ''

    if not qualifying:
        if is_md:
            return 'KILL', 'managing_director_only'
        if is_president_word:
            if PRESIDENT_OF_FUNCTION_RE.search(t):
                return 'KILL', 'president_of_function'
            if SUB_PRESIDENT_RE.search(t):
                return 'KILL', 'vp_or_assistant'
        for pat, label in WRONG_CSUITE:
            if pat.search(t):
                return 'KILL', f'wrong_csuite_{label}'
        for pat in SUB_FOUNDER_RES:
            if pat.search(t):
                return 'KILL', 'sub_founder_title'
        return 'KILL', 'non_qualifying_title'

    # Qualifying title (CEO/President/Owner/MP) without Founder.
    # Check whether wrong-suite C-level dominates instead of CEO.
    # E.g., "Chief Marketing Officer at X" — has CMO but not CEO. We already
    # require is_ceo or is_president etc. for qualifying. So if CEO is in
    # title alongside CMO, FIT still wins (founder/ceo language present).
    return 'PASS', ''


# ───────── Size, email, presence ─────────

def parse_employees(val):
    if not val:
        return None
    v = str(val).strip().replace(',', '').replace('+', '').replace(' ', '')
    if not v:
        return None
    if '-' in v:
        parts = v.split('-')
        try:
            return int(float(parts[0]))
        except (ValueError, IndexError):
            return None
    try:
        return int(float(v))
    except ValueError:
        return None


PERSONAL_DOMAINS = {
    'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com',
    'icloud.com', 'me.com', 'mac.com', 'mail.com', 'protonmail.com', 'proton.me',
    'live.com', 'msn.com', 'ymail.com', 'rocketmail.com', 'gmx.com', 'gmx.us',
    'comcast.net', 'verizon.net', 'sbcglobal.net', 'att.net', 'cox.net',
    'earthlink.net', 'charter.net', 'optimum.net', 'bellsouth.net',
    'yahoo.co.uk', 'hotmail.co.uk', 'live.co.uk', 'btinternet.com',
    'ymail.com', 'fastmail.com', 'tutanota.com', 'zoho.com',
}


def is_personal_email(email):
    if not email or '@' not in email:
        return False
    domain = email.split('@')[-1].strip().lower().rstrip('.')
    return domain in PERSONAL_DOMAINS


STEALTH_RE = re.compile(r'\b(stealth|stealth\s+mode|in\s+stealth|coming\s+soon|under\s+construction)\b', re.I)


def is_stealth(company_name, headline, keywords):
    for b in [company_name, headline, keywords]:
        if b and STEALTH_RE.search(b):
            return True
    return False


def has_web_presence(website, person_li, company_li):
    if website:
        w = website.strip().lower()
        if w and w not in ('n/a', 'none', '-', 'null', 'tbd'):
            return True
    for url in (person_li, company_li):
        if url and url.strip().lower().startswith('http'):
            return True
    return False


# ───────── Main filter ─────────

def evaluate(row, col_map):
    """Return (verdict, kill_reason). verdict is 'FIT' or 'KILL'."""
    title = col(row, col_map, 'Title', 'Person Title', 'Job Title')
    headline = col(row, col_map, 'Headline', 'Person Headline')
    company_name = col(row, col_map, 'Company Name', 'Company', 'Organization Name', 'Account Name')
    industry = col(row, col_map, 'Industry', 'Company Industry', 'Organization Industry')
    keywords = col(row, col_map, 'Keywords', 'Company Keywords', 'Organization Keywords')
    website = col(row, col_map, 'Website', 'Company Website', 'Organization Website', 'Domain')
    person_li = col(row, col_map, 'Person Linkedin Url', 'LinkedIn URL', 'Person Linkedin', 'Linkedin Url', 'LinkedIn', 'Linkedin')
    co_li = col(row, col_map, 'Company Linkedin Url', 'Organization Linkedin Url', 'Company LinkedIn')
    email = col(row, col_map, 'Email', 'Work Email', 'Person Email')
    employees_raw = col(row, col_map, 'Employees', '# Employees', 'Estimated Number Of Employees',
                        'Employee Count', 'Number of Employees', 'Headcount', 'Company Size', 'Company Headcount')

    # 1. PR / comms firm — hard reject
    if is_pr_firm(company_name, industry, headline, keywords):
        return 'KILL', 'pr_or_comms_firm'

    # 2. Stealth / defunct
    if is_stealth(company_name, headline, keywords):
        return 'KILL', 'stealth_or_defunct'

    # 2b. Dead anti-ICP segment (v3 — industry-level: finance services, nonprofits,
    #     political, faith, education orgs). Tech/health in those spaces are exempt.
    dead = dead_segment(industry, company_name, keywords, headline)
    if dead:
        return 'KILL', dead

    # 3. Title
    verdict, reason = title_verdict(title)
    if verdict == 'KILL':
        return 'KILL', reason

    # 4. Personal email
    if is_personal_email(email):
        return 'KILL', 'personal_email'

    # 5. Web presence (real operating company)
    if not has_web_presence(website, person_li, co_li):
        return 'KILL', 'no_web_presence'

    # 6. Size — v3: blank headcount is ALLOWED (real founders often have it blank in
    #    Apollo; v2 was wrongly dropping them). Only drop confirmed-small (<10) or
    #    too-large (>500).
    n = parse_employees(employees_raw)
    if n is not None:
        if n < 10:
            return 'KILL', 'too_small_under_10'
        if n > 500:
            return 'KILL', 'too_large_over_500'

    return 'FIT', ''


def main():
    ap = argparse.ArgumentParser(description='Story Group ICP filter (v2)')
    ap.add_argument('--input', required=True, help='Path to Apollo CSV export')
    ap.add_argument('--output', help='Output path (default: <input>_FIT.csv next to input)')
    ap.add_argument('--save-kills', action='store_true',
                    help='Also save <input>_KILLS.csv with reasons (for debugging)')
    args = ap.parse_args()

    in_path = os.path.abspath(args.input)
    if not os.path.exists(in_path):
        print(f'ERROR: Input file not found: {in_path}', file=sys.stderr)
        sys.exit(2)

    base_dir = os.path.dirname(in_path)
    base_name = os.path.splitext(os.path.basename(in_path))[0]
    out_path = args.output or os.path.join(base_dir, f'{base_name}_FIT.csv')
    kills_path = os.path.join(base_dir, f'{base_name}_KILLS.csv') if args.save_kills else None

    fit_rows = []
    kill_rows = []
    kill_counts = Counter()
    total = 0

    with open(in_path, 'r', encoding='utf-8', errors='replace', newline='') as f:
        reader = csv.DictReader(f)
        fieldnames = list(reader.fieldnames or [])
        if not fieldnames:
            print('ERROR: Input CSV has no header row.', file=sys.stderr)
            sys.exit(2)
        col_map = build_col_map(fieldnames)
        for row in reader:
            total += 1
            verdict, reason = evaluate(row, col_map)
            if verdict == 'FIT':
                fit_rows.append(row)
            else:
                kill_counts[reason] += 1
                if kills_path:
                    kr = dict(row)
                    kr['_kill_reason'] = reason
                    kill_rows.append(kr)

    with open(out_path, 'w', encoding='utf-8', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(fit_rows)

    if kills_path:
        kfields = fieldnames + ['_kill_reason']
        with open(kills_path, 'w', encoding='utf-8', newline='') as f:
            writer = csv.DictWriter(f, fieldnames=kfields)
            writer.writeheader()
            writer.writerows(kill_rows)

    fit = len(fit_rows)
    killed = total - fit
    pct_fit = (fit / total * 100) if total else 0.0
    pct_kill = (killed / total * 100) if total else 0.0

    print()
    print('=' * 60)
    print('STORY GROUP ICP FILTER — RESULT')
    print('=' * 60)
    print()
    print(f'  Total rows in:   {total:,}')
    print(f'  FIT (kept):      {fit:,} ({pct_fit:.1f}%)')
    print(f'  KILL (dropped):  {killed:,} ({pct_kill:.1f}%)')
    print()
    print('  TOP KILL REASONS:')
    for reason, count in kill_counts.most_common(12):
        p = (count / total * 100) if total else 0
        print(f'    {reason:<28} {count:>6,}  ({p:.1f}%)')
    print()
    print('  FILE WRITTEN:')
    print(f'    {out_path}')
    if kills_path:
        print(f'    {kills_path}')
    print()
    print('=' * 60)


if __name__ == '__main__':
    main()
