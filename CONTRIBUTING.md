# Working on MailBlaster

Read [ARCHITECTURE.md](ARCHITECTURE.md) first for the why. This file is the
operational detail: setup, conventions, invariants you must not break, and the
traps that have already caught someone.

---

## Setup

```bash
npm install
npm test                     # 74 tests, no network or secrets required
npm start                    # http://localhost:3000
PORT=3100 npm start          # if 3000 is taken
```

Node 22.5+ is required — `node:sqlite` is built in from that version.

### Optional: run against Postgres

```bash
# .env.local  (gitignored; never commit a connection string)
DATABASE_URL="postgresql://user:pass@host-pooler.neon.tech/neondb?sslmode=require"
```

Load it into the shell before starting:

```bash
export DATABASE_URL=$(grep -o 'postgresql://[^"]*' .env.local | head -1)
npm start
node test.js                 # same suite, Postgres driver
```

Use the **-pooler** host. Serverless functions open many short-lived
connections and the pooler is built for that.

### Gmail requirements

- **App Password**, not the account password. Needs 2-Step Verification:
  `myaccount.google.com → Security → 2-Step Verification → App passwords`.
- For reply detection, IMAP must be on:
  `Gmail → Settings → Forwarding and POP/IMAP → Enable IMAP`.
- Port 587 (STARTTLS) is the default because many networks block 465.

---

## Layout

```
api/          one file per endpoint; thin — validate, call a lib, respond
lib/          all the judgement; testable without network or database
app.js        frontend: send loop, rendering, drill-downs
index.html    markup, plus the <template> both mail windows are cloned from
test.js       the suite
lib/schema.sql  the Postgres schema (SQLite mirror lives in store.js)
```

---

## Invariants

Break these and the app is unsafe, not merely buggy.

**1. De-duplication lives in the database.**
Three UNIQUE constraints — `recipients.email`, `sends(campaign_id,
recipient_id)`, `replies(mailbox, imap_uid)`. Never "optimise" them away in
favour of a client-side check. The send loop runs in a browser tab that can be
duplicated or reloaded.

**2. `sends.message_id` must always be written.**
Reply matching and threading both depend on it. It was silently dropped once
already.

**3. Schema changes are additive only.**
`IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`, in `lib/schema.sql` **and** the
SQLite mirror in `lib/store.js`. Both drivers must stay in step — the test
suite runs against each and expects identical behaviour.

**4. Credentials are never persisted or logged.**
The App Password is per-request. `lib/log.js` redacts anything matching
`pass|password|token|secret|authorization`. Do not log a request body without
passing it through `log.safe()`.

**5. Suppression is decided server-side at send time.**
Not from a list the page loaded earlier. A tab open for an hour has a stale
idea of who has replied.

**6. Never ship stored bodies in a list response.**
`/api/log` returns metadata; `/api/body?id=` fetches one. This is a transfer
budget decision, not a style preference.

---

## Conventions

**Errors.** Never invent an ad-hoc shape. Add a code to `lib/errors.js` with a
`retry` policy and return `describe(err)`:

```js
const { describe, httpFor, classify } = require('../lib/errors');
catch (e) { send(res, httpFor(classify(e)), describe(e)); }
```

Choosing `retry` is a real decision:

- `auto` — transient, safe to repeat
- `confirm` — **may already have succeeded**; ask first
- `never` — cannot help, or actively harmful (auth failures lock accounts)

**Logging.** Wrap every handler. One JSON line per request, with duration and
status:

```js
module.exports = log.wrap('name', async function handler(req, res) { ... });
```

**Frontend ids.** Both mail windows are cloned from `#mailWindowTpl`, and each
`data-id` becomes `prefix + Id` — `composeSubject`, `fuSubject`. Add fields to
the template, never to one window only; that is what keeps them from drifting.

**Bind defensively.** `if ($(id)) $(id).addEventListener(...)`. One missing
element that throws during load leaves every handler after it unbound, and the
page looks entirely dead. This has happened.

---

## Testing

```bash
npm test                                    # SQLite
DATABASE_URL="postgres://..." node test.js  # Postgres — must also pass
```

Write tests as invariants, so a regression is obvious from the name:

```js
await test('THE GUARD: the same person cannot be sent twice in one campaign', ...)
await test('auth failures are never retried (Google locks the account)', ...)
```

**Test the classifier against realistic replies, not synthetic ones.** Three
real bugs were found this way — the killer being *"I was out of office last
week, sorry for the delay — very interested!"* filed as an auto-responder,
which would silently drop a live prospect from every follow-up.

**Verify the frontend by executing it**, not by reading it:

```js
const dom = new JSDOM(html, { runScripts: 'outside-only' });
dom.window.fetch = () => Promise.resolve({ json: () => Promise.resolve({ ok: true }) });
dom.window.eval(fs.readFileSync('app.js', 'utf8'));   // must not throw
// then assert: both windows mounted, no button without an onclick
```

---

## Traps

| Trap | Reality |
|---|---|
| "SQLite will do on Vercel" | Read-only filesystem. `ENOENT`, driver falls back to `none`. |
| "Add a cron to poll replies" | Hobby cron is **one run per day**, and it needs the password stored server-side. |
| "Retry the timeout automatically" | Gmail may have accepted it. That is a duplicate email. |
| "An OOO means stop contacting them" | It means *try after this date*. Suppressing loses a live contact. |
| "Fetch everything, filter in the browser" | ~12 MB per campaign start against a 5 GB monthly allowance. |
| "Match replies on the From address" | Aliases and forwards break it. `In-Reply-To` first, address only as fallback. |

---

## Free-tier limits

| Limit | Value |
|---|---|
| Neon storage | 0.5 GB (~50k sends with bodies) |
| Neon compute | 100 CU-hours/month (a 10k campaign ≈ 0.6%) |
| Neon transfer | 5 GB/month |
| Vercel function | 60s; IMAP scans budget ~40s and resume |
| Vercel cron | 1/day on Hobby |
| **Gmail send** | **~500/day free, ~2000 Workspace — the real ceiling** |

Neon scales to zero after 5 minutes idle, so the first query of a campaign
takes 1–2s. It stays warm for the rest of the run.
