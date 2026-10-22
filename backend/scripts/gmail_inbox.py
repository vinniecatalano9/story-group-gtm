#!/usr/bin/env python3
"""gmail_inbox.py: read-only looks at vincent@storygroup.io over IMAP. Never sends.

Reads JSON on stdin, one of:
  {"op": "replies", "emails": ["a@x.com", ...], "since": "2026-10-22"}
      -> {"ok": true, "messages": [{from, subject, date, message_id, in_reply_to, snippet, auto}]}
      Every message FROM those addresses since that day, in All Mail (so archived
      replies count). auto = out-of-office / auto-reply.
  {"op": "signature"}
      -> {"ok": true, "html": "..."}  the gmail_signature block from the newest
      sent email that has one ("" when none found).
Same root-only login file as gmail_draft.py.
"""
import email, imaplib, json, re, sys
from email.header import decode_header, make_header
from email.utils import parseaddr, parsedate_to_datetime
from datetime import datetime

LOGIN = "/root/.gmail-login"


def connect():
    login = json.load(open(LOGIN))
    m = imaplib.IMAP4_SSL("imap.gmail.com", timeout=60)
    m.login(login["email"], login["password"])
    return m


def text_of(msg):
    plain, html = "", ""
    for p in msg.walk():
        if p.get_content_maintype() == "multipart" or p.get("Content-Disposition", "").startswith("attachment"):
            continue
        try:
            body = p.get_payload(decode=True).decode(p.get_content_charset() or "utf-8", "replace")
        except Exception:
            continue
        if p.get_content_type() == "text/plain" and not plain:
            plain = body
        elif p.get_content_type() == "text/html" and not html:
            html = body
    if not plain and html:
        plain = re.sub(r"<[^>]+>", " ", html)
    # Drop the quoted thread below their answer.
    plain = re.split(r"\n\s*On .{5,200}wrote:\s*\n|\n-----Original Message-----|\nFrom: .*\nSent: ", plain)[0]
    plain = "\n".join(l for l in plain.splitlines() if not l.startswith(">"))
    return re.sub(r"\n{3,}", "\n\n", plain).strip()[:1500]


def hdr(v):
    try:
        return str(make_header(decode_header(v or "")))
    except Exception:
        return v or ""


def replies(req):
    m = connect()
    m.select('"[Gmail]/All Mail"', readonly=True)
    since = datetime.strptime(req["since"][:10], "%Y-%m-%d").strftime("%d-%b-%Y")
    out = []
    for addr in sorted(set(e.lower() for e in req.get("emails", []) if e)):
        typ, data = m.search(None, "FROM", f'"{addr}"', "SINCE", since)
        if typ != "OK":
            continue
        for i in data[0].split()[-20:]:
            typ, d = m.fetch(i, "(BODY.PEEK[])")
            msg = email.message_from_bytes(d[0][1])
            sender = parseaddr(msg.get("From", ""))[1].lower()
            if sender != addr:
                continue
            subj = hdr(msg.get("Subject"))
            auto = bool(msg.get("Auto-Submitted", "no").lower() != "no" or msg.get("X-Autoreply") or msg.get("X-Autorespond")
                        or re.search(r"\b(automatic reply|auto[- ]?reply|out of (the )?office|autoreply)\b", subj, re.I))
            try:
                date = parsedate_to_datetime(msg.get("Date")).isoformat()
            except Exception:
                date = None
            out.append({"from": sender, "subject": subj, "date": date, "message_id": msg.get("Message-ID", ""),
                        "in_reply_to": msg.get("In-Reply-To", ""), "snippet": text_of(msg), "auto": auto})
    m.logout()
    return {"ok": True, "messages": out}


def signature(req):
    m = connect()
    m.select('"[Gmail]/Sent Mail"', readonly=True)
    typ, data = m.search(None, "ALL")
    for i in reversed(data[0].split()[-60:]):
        typ, d = m.fetch(i, "(BODY.PEEK[])")
        msg = email.message_from_bytes(d[0][1])
        if msg.get("X-Cadence"):
            continue  # our own sends carry the cached copy; read a hand-written one
        for p in msg.walk():
            if p.get_content_type() != "text/html":
                continue
            h = p.get_payload(decode=True).decode(p.get_content_charset() or "utf-8", "replace")
            k = h.find('class="gmail_signature"')
            if k < 0:
                continue
            start = h.rfind("<div", 0, k)
            # Balance divs from the signature's opening tag.
            depth, j = 0, start
            for t in re.finditer(r"<div\b|</div>", h[start:]):
                depth += 1 if t.group(0) == "<div" else -1
                if depth == 0:
                    j = start + t.end()
                    break
            m.logout()
            return {"ok": True, "html": h[start:j], "from_subject": hdr(msg.get("Subject"))}
    m.logout()
    return {"ok": True, "html": ""}


if __name__ == "__main__":
    try:
        req = json.load(sys.stdin)
        print(json.dumps({"replies": replies, "signature": signature}[req["op"]](req)))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)[:300]}))
        sys.exit(1)
