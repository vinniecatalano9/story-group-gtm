#!/usr/bin/env python3
"""gmail_draft.py: put one draft in vincent@storygroup.io's Gmail. Never sends.

Reads JSON on stdin: {"to": "...", "subject": "...", "body": "..."}.
IMAP APPEND into [Gmail]/Drafts with the \\Draft flag, using the root-only app
password in /root/.gmail-login (the same login lead-ping and gmail-att use).
Prints {"ok": true} or {"ok": false, "error": "..."}.
"""
import imaplib, json, sys, time
from email.message import EmailMessage
from email.utils import formatdate, make_msgid

LOGIN = "/root/.gmail-login"


def main():
    req = json.load(sys.stdin)
    login = json.load(open(LOGIN))
    msg = EmailMessage()
    msg["From"] = login["email"]
    msg["To"] = req["to"]
    msg["Subject"] = req["subject"]
    msg["Date"] = formatdate(localtime=True)
    msg["Message-ID"] = make_msgid(domain=login["email"].split("@")[1])
    msg.set_content(req["body"])
    m = imaplib.IMAP4_SSL("imap.gmail.com", timeout=60)
    m.login(login["email"], login["password"])
    typ, data = m.append('"[Gmail]/Drafts"', "\\Draft", imaplib.Time2Internaldate(time.time()), msg.as_bytes())
    m.logout()
    if typ != "OK":
        raise RuntimeError(f"APPEND {typ} {data}")
    print(json.dumps({"ok": True}))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)[:300]}))
        sys.exit(1)
