# MailBlaster

A Gmail bulk-mailer with campaign history, reply detection and threaded
follow-ups. Static frontend plus small serverless functions — no framework, no
build step. Runs locally with `npm start` and deploys to Vercel from GitHub
with no configuration.

The thing that makes it more than a mail-merge script: **it knows who has
already replied, and refuses to email them again.** That guarantee is enforced
by the database, not by the browser, so it holds across devices, browser tabs
and retried requests.

## The five sections

| # | Section | What it does |
|---|---------|--------------|
| 1 | **Gmail** | Address, 16-character App Password, display name, reply-to, SMTP port (465 SSL or 587 STARTTLS). *Verify connection* does a real SMTP handshake before you send anything. Credentials are stored in your browser by default; a successful Verify also saves them encrypted server-side (if `ACCOUNTS_ENCRYPTION_KEY` is set) so a second browser or device doesn't need them re-entered. |
| 2 | **Recipients** | Paste addresses in any format. Duplicates are dropped and the salutation is parsed out of the address itself: `aditya.jha@acme.com` → *Aditya*. Role inboxes (`info@`, `hr@`, `sales@`) are flagged amber; addresses with no separator to confirm where a first name ends (`yashagrobiotech@`, `drdjha@`, `sm@`) are flagged **check this name**, because a greeting is the first thing a recipient reads. Flagged does not mean wrong — `harvinder@` is a real first name — so the app asks rather than rewrites. |
| 3 | **Compose** | A mail window, not a form: From / To / Subject at the top, then greeting, body, sign-off flowing as one sheet, with signature and attachments collapsed below and the send bar at the foot. Rich text, merge tags (`{{name}}`, `{{full_name}}`, `{{email}}`), inline signature image, attachments. |
| 4 | **Campaigns** | Every run for the signed-in Gmail account. Drill in: campaign → the people in it → **one person's whole conversation**, oldest first. A stopped run gets a **Resume** button. |
| 5 | **Replies** | Scans the inbox over IMAP and sorts what it finds into replied / out-of-office / bounced / unsubscribed / no reply. Below it, the follow-up composer — the same mail window as Section 3, sending a **threaded reply** to people who never answered. |

## Run locally

```bash
npm install
npm start                    # http://localhost:3000
PORT=3100 npm start          # or another port
npm test                     # 74 tests, no network or secrets needed
```

With no `DATABASE_URL` set, history is kept in SQLite at `data/mail.db` —
built into Node 22.5+, so nothing to install.

## Deploy

Push to GitHub; Vercel builds automatically. One environment variable is the
whole configuration:

```
DATABASE_URL=postgresql://user:pass@host.neon.tech/neondb?sslmode=require
```

**SQLite cannot work on Vercel** — the filesystem is read-only, which the app
reports honestly (`driver: none`) rather than failing quietly. Without a
database the browser falls back to its own localStorage copy, which is
per-browser and therefore cannot de-duplicate across devices.

Vercel discontinued its own Postgres product and now points to the
[Neon integration](https://vercel.com/marketplace/neon); its free tier needs no
card, and the schema migrates itself on the first request after a deploy.

## What it guarantees

| Guarantee | How |
|---|---|
| Nobody is emailed twice in one campaign | `UNIQUE(campaign_id, recipient_id)` in the database |
| Nobody who replied is emailed again | `do_not_contact` on the person, checked server-side at send time |
| An interrupted run can resume safely | The remainder is rebuilt from the database, not the tab |
| Re-scanning the inbox is harmless | `UNIQUE(mailbox, imap_uid)` |
| A wrong password never locks your account | Auth failures are `retry: never` |
| An out-of-office does not lose a contact | Recorded as *retry after this date*, not as suppression |

## Documentation

| Document | For |
|---|---|
| [API.md](API.md) | Every endpoint, request and response shape |
| [ARCHITECTURE.md](ARCHITECTURE.md) | How it fits together, and why it is built this way |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Working on the code — conventions, invariants, pitfalls |

## Requirements

- Node 22.5 or newer (`node:sqlite` is built in from 22.5)
- A Gmail **App Password** — 2-Step Verification must be on:
  `myaccount.google.com → Security → 2-Step Verification → App passwords`
- For reply detection, IMAP enabled:
  `Gmail → Settings → Forwarding and POP/IMAP → Enable IMAP`

Gmail's own limits bind long before anything here does: roughly 500
recipients/day on a free account, 2,000 on Workspace.
