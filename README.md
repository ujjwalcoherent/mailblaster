# MailBlaster

A four-section Gmail bulk-mailer. Static frontend + three tiny serverless functions — no framework, no build step, one npm dependency (`nodemailer`). Runs locally with `npm start` and deploys to Vercel from GitHub with zero configuration.

## The four sections

| # | Section | What it does |
|---|---------|--------------|
| 1 | **Gmail** | Gmail address + 16-character **App Password**, display name, reply-to, SMTP port (465 SSL or 587 STARTTLS). "Verify connection" does a real SMTP handshake before you send anything. Credentials stay in your browser's localStorage — they are never stored server-side. |
| 2 | **Recipients** | Paste email IDs in any format (commas, spaces, newlines, pasted columns). Duplicates are dropped and the **salutation is parsed out of the email ID itself** — `aditya.jha@acme.com` → *Aditya*, `priya_sharma@x.in` → *Priya*, `rahulVerma99@x.com` → *Rahul*. Generic inboxes (`info@`, `hr@`, `sales@`…) are flagged in amber and fall back to a name you choose. Every parsed name is editable inline. |
| 3 | **Compose** | Rich-text canvas — select text and hit **B**, *I*, underline, **Highlight** (any colour), text colour, lists, links. Toggle `</> HTML` to hand-edit the source. Plus a separate **ending greeting**, an **HTML footer** (signature / disclaimer / unsubscribe), a **footer image** (PNG/JPG signature or banner, with width, position and optional click-through link), and **attachments** including PDFs. Merge tags: `{{name}}`, `{{full_name}}`, `{{email}}` — usable in the subject too. Preview renders the first recipient's actual email. |
| 4 | **Analytics** | Every attempt is logged **live as it happens**: total / delivered / failed / success rate, a per-day stacked bar chart, a searchable log with failure reasons on hover, and CSV export. The panel states which store it is reading so you always know whether the history is shared or browser-only. |

## Run locally

Double-click **`start.bat`**, or:

```bash
npm install
npm start          # http://localhost:3000   (PORT=3111 npm start to change it)
```

Requires **Node 22.5+** — the SQLite archive uses the built-in `node:sqlite`, so there is nothing native to compile.

## Deploy (GitHub → Vercel)

```bash
git init && git add -A && git commit -m "MailBlaster"
git remote add origin https://github.com/<you>/mailblaster.git
git push -u origin main
```

Then on Vercel: **Add New → Project → import the repo → Deploy**. No framework preset, no build command, no environment variables. `vercel.json` only bumps the function timeout to 30s.

Vercel picks up `api/*.js` as functions and serves the root as static — the same routing `dev-server.js` reproduces locally, so what you test is what ships.

## How it's wired

```
index.html · style.css · app.js     static frontend, all the UI logic
api/verify.js                       SMTP handshake check
api/send.js                         sends ONE email per request
api/log.js                          reads/clears the SQLite archive
lib/util.js · lib/store.js          name parsing + merge tags · SQLite
dev-server.js                       local clone of Vercel's routing
```

The browser loops over the recipient list and calls `/api/send` once per person. That keeps each invocation far inside the serverless time limit, needs no queue or job state on the server, and gives live per-recipient progress for free. The delay between mails (default 800 ms) is a client-side pause.

**The trade-off: the tab is the engine.** Reloading or closing the page mid-campaign stops it — everyone already sent stays sent, everyone after the cut-off is never called. The app defends against this three ways: a browser warning if you try to leave while sending, a **Stop** button for deliberate halts, and **Skip already-sent** in Section 2, which drops every address already delivered so a resumed run can't double-send. Backgrounding the tab doesn't stop it, but browsers throttle timers in hidden tabs, so it runs slower.

A campaign that must survive a closed laptop needs a real server-side queue — a different design, and a much heavier one.

## The footer image

The PNG is attached with a `Content-ID` and referenced as `<img src="cid:…">`, producing a `multipart/related` message. This matters: Gmail and Outlook both strip `data:` URI images, so a base64-inlined signature renders as a broken box for most recipients — the CID route displays reliably.

Keep it small. A 500 KB signature adds ~680 KB to *every* message once base64-encoded, which slows each send and makes spam filters less friendly. Around 30–60 KB at the width you actually display is a good target.

## Where the log lives

`lib/store.js` picks one of three drivers at runtime:

| Driver | When | Shared? |
|---|---|---|
| **postgres** | `POSTGRES_URL` is set | Yes — every device and visitor sees the same history |
| **sqlite** | writable disk (i.e. running locally) → `data/mail.db` | No — that one machine |
| **none** | read-only disk, no database | No — falls back to the browser's own `localStorage` |

Every send is *also* written to `localStorage`, so the browser always has a copy.

**On Vercel you need Postgres, or Section 4 shows nothing to anyone but you.** Vercel's function filesystem is read-only, so SQLite can't initialise there — `/api/log` returns `available:false` with the reason, and each visitor sees only what their own browser recorded.

To turn it on: Vercel dashboard → **Storage** → **Create Database** → Postgres (Neon) → connect it to the project. That injects `POSTGRES_URL` automatically; redeploy and the table is created on first request. No code change needed.

## Not sending twice

De-duplication happens at three points:

1. **On parse** — repeated addresses in the pasted list are collapsed, case-insensitively, and the count of removed duplicates is reported.
2. **On send** — a final pass catches duplicates introduced by editing rows after parsing.
3. **Against history** — anyone already delivered to in a previous run is detected before sending, listed, and you choose whether to skip them or deliberately send again.

**Skip already-sent** in Section 2 does step 3 on demand, which is how you resume an interrupted campaign: re-paste the whole list, parse, skip, send.

## Notes and limits

- **Port 587 is the default** because port 465 is blocked on many networks — including this one, where 465 returns `EACCES` while 587 reaches Google normally. If you ever see `EACCES` / `ECONNREFUSED` / `ETIMEDOUT`, the connection never left the machine; that is a network block, not a credentials problem, and switching ports is the fix.
- **App Password required.** Enable 2-Step Verification, then create one at *myaccount.google.com → Security → App passwords*. Your regular Gmail password will not authenticate.
- **Gmail sending limits** are roughly 500 recipients/day for a personal account and 2,000 for Workspace. Exceeding them gets the account rate-limited.
- **Attachments over ~4.5 MB total** will fail on Vercel — hosted functions cap the request body. The app warns you before sending. Locally there is no such cap.
- Credentials are posted to your own function per send and used only for that SMTP connection; nothing is persisted server-side.
- Keep the deployment private, or put Vercel access protection on it — anyone who can open the page can send mail through whatever credentials they type in.
