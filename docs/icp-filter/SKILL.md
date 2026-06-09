---
name: storygroup-icp-filter
description: Filter an Apollo CSV export against the Story Group v2 ICP. Use when Vincent says "filter my Apollo list", "filter against ICP", "qualify these leads", "clean my Apollo export", "run ICP filter", "check leads against ICP", "drop the bad leads", or hands over an Apollo CSV path and asks to remove non-ICP rows. Outputs a FIT-only CSV (same columns and column order as input — no verdict columns added) plus a terminal summary of kill reasons. Filter is autonomous: every row gets a binary FIT/KILL decision deterministically, no rows are kicked back for human review.
---

# Story Group ICP Filter (v3 — data-driven)

This skill takes an Apollo lead CSV and writes a filtered version containing only ICP-matched rows (FIT). All non-fit rows (KILL) are dropped from the output. The bundled `filter.py` script encodes every v2 ICP rule deterministically — the script makes the call, you don't.

**Pricing context**: Story Group sells PR retainers at $5K–$25K/mo. ICP is the founder/CEO who signs the check, not a comms team.

## v2 ICP — what's filtered

**Buyer titles (FIT)**: Founder, Co-founder, CEO, President, Owner, Managing Partner.
**Company size (FIT)**: 10–500 employees.
**Real operating company (FIT)**: has website OR populated LinkedIn URL.
**Industry (v3 — now a gate, built from real response data)**: KILL dead anti-ICP segments that convert ~zero — compliance finance (RIAs / insurance / credit unions / CPAs / lending), nonprofits/charities, political & election orgs, faith/religious orgs, education orgs (schools/districts). Genuine tech companies in those spaces (fintech / insurtech / edtech) are EXEMPT. Everything else passes; health/biotech/pharma, govcon/professional-services, and funded tech convert strongest.

**Other v3 changes**: "Partner" (pro-services owner) now qualifies as a buyer title; blank employee count no longer auto-kills (v2 was dropping real founders with empty headcount — only confirmed <10 or >500 are dropped now). v2 backup preserved at `filter_v2_backup.py`.

**Hard KILL when ANY**:
- PR firm / comms agency / publicity shop / media-relations consultancy (competitors)
- Sub-founder title (VP, Director, Manager, Head of, Lead, Senior, Principal, Associate)
- Wrong-suite C-level (CMO, COO, CFO, CTO, CRO, CIO, etc.) **without** "Founder" also in title
- Personal email (gmail / yahoo / hotmail / outlook / aol / icloud / proton)
- Stealth / defunct / no web presence
- Company size < 10 or > 500 employees
- "Former ___" / "Ex-___" / "Retired"
- "Open to work" / "Between roles" / "In transition"
- "Managing Director" alone (not Managing Partner, not also Founder/CEO)
- "Executive Assistant to CEO" / "Chief of Staff to the CEO" / similar support roles

**Edge cases the script resolves automatically** (no human review):
- "Founder & [anything]" → FIT (Founder presence wins)
- "President of Sales/Marketing/etc." → KILL (functional, not company-wide)
- "VP / EVP / SVP / Associate President" → KILL
- Solo (1–9 employees) → KILL by default
- Missing employee count → KILL (can't confirm 10–500 range)

## How to invoke

1. **If no input path was given**, ask the user for the absolute path to the Apollo CSV.
2. Run the bundled script:
   ```bash
   python3 ~/.claude/skills/storygroup-icp-filter/filter.py --input "<path>"
   ```
3. To also save a `_KILLS.csv` (with kill-reason column, for debugging):
   ```bash
   python3 ~/.claude/skills/storygroup-icp-filter/filter.py --input "<path>" --save-kills
   ```
4. To override the output path:
   ```bash
   python3 ~/.claude/skills/storygroup-icp-filter/filter.py --input "<path>" --output "<out>"
   ```
5. The script writes `<input>_FIT.csv` next to the input by default. The output preserves the input's columns and column order exactly — no verdict columns are added.
6. Surface the script's terminal summary (totals + top kill reasons) to the user as your response. Don't add commentary unless the user asks.

## Output contract

- **File**: `<input>_FIT.csv` — same columns, same order, FIT rows only.
- **Terminal**: total in, FIT count and %, KILL count and %, top kill reasons.
- **Side files** (only with `--save-kills`): `<input>_KILLS.csv` with a `_kill_reason` column appended.

## Column resolution

The script handles common Apollo header variants automatically (`Title` / `Person Title`, `# Employees` / `Number of Employees` / `Headcount`, `Person Linkedin Url` / `LinkedIn URL`, etc.). If the user's CSV uses entirely non-standard column names, the script will run but may KILL too aggressively — flag this and ask the user to share their headers.

## When NOT to use this skill

- Audit / scoring tasks that need a STRONG/WEAK/NOT_FIT/UNCLEAR breakdown rather than a binary FIT/KILL → that's a different ICP version (v1, industry-weighted with revenue band). Don't conflate the two.
- Lead enrichment, scraping, or data hydration → out of scope. This filter only drops rows; it never adds data.
- ICP definitions other than Story Group v2 → don't repurpose this script. Create a new skill or update the rules in `filter.py` deliberately.
