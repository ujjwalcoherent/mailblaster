# MailBlaster API

Every endpoint lives in `api/` and is a plain Node handler. Vercel maps
`api/<name>.js` to `/api/<name>`; `dev-server.js` does the same locally, so the
same code runs in both places with no build step.

## Conventions

**Errors.** Every failure returns the same shape, from a single table in
[`lib/errors.js`](lib/errors.js):

```json
{
  "ok": false,
  "code": "AUTH_REJECTED",
  "error": "Gmail rejected these credentials.",
  "hint": "Use a 16-character App Password, not your account password.",
  "retry": "never",
  "detail": "535-5.7.8 Username and Password not accepted"
}
```

`retry` is the field that matters:

| Value | Meaning | Examples |
|---|---|---|
| `auto` | Transient. Safe to retry with backoff. | `SEND_RATE_LIMIT`, `DB_COLD_START` |
| `confirm` | **May already have succeeded** — ask before retrying. | `SEND_TIMEOUT` |
| `never` | Retrying cannot help, or actively harms. | `AUTH_REJECTED`, `SEND_NO_SUCH_USER` |

`SEND_TIMEOUT` is `confirm` because Gmail may have accepted the message before
the socket dropped; a blind retry would send it twice. Auth failures are
`never` because Google locks an account after repeated bad logins.

**Authentication.** When the deployment sets `MAILBLASTER_API_KEY`, every
endpoint requires it. Send it one of three ways:

```
Authorization: Bearer <key>
X-API-Key: <key>
?key=<key>                     # convenient for curl; ends up in server logs
```

Without it, endpoints return `401 UNAUTHORIZED`. When the variable is unset the
check is skipped entirely, so local development needs no setup — which is safe
locally and unsafe on a public host, so a hosted deployment must set it.

This is **one key for the whole deployment**, not a per-user credential:
anyone holding it can read and delete everything this deployment stores. It is
suitable for a private tool, not for handing to third-party developers. Real
multi-tenant access would need keys stored against an owner and every query
scoped to that owner — campaigns are currently scoped by Gmail address, which
is a convenience for showing the right history, not a security boundary.

The key is compared in constant time (`lib/auth.js`); a plain `===` leaks the
position of the first wrong character through timing.

**Credentials.** The Gmail App Password is sent per request and never stored,
logged, or written to the database. Only the sending address is persisted, as
the key that scopes history to an account.

**Logging.** Each request emits one JSON line (`lib/log.js`) with the endpoint,
method, status and duration. Passwords, tokens and message bodies are redacted
before anything is written.

---

## `GET /api/log`

The send log, newest first. **Never includes message bodies** — those are
several KB each and are fetched one at a time by `/api/body`.

```json
{ "ok": true, "available": true, "driver": "postgres",
  "rows": [ { "id": 1, "time": "...", "to": "a@b.com", "subject": "...",
              "status": "sent", "messageId": "<x@mail>" } ] }
```

`available: false` means no database is configured; the browser then falls back
to its own localStorage copy, which cannot de-duplicate across devices.

`DELETE /api/log` clears campaigns, sends and replies. Known addresses are
kept, with their send history reset.

---

## `GET /api/campaigns`

| Query | Purpose |
|---|---|
| `owner` | Scope to one Gmail account. Omit it to get every account's campaigns together — the combined view a multi-account dashboard needs. |
| `limit` | Max rows, default 100, capped at 500 |
| `id` + `people=1` | The people inside one campaign |
| `quota` | An account's email — returns its rolling 24h send count instead of a campaign list (see below) |

```json
{ "ok": true, "campaigns": [
  { "id": "3", "name": "Q3 Outreach", "subject": "Introducing our new range",
    "from": "me@gmail.com",
    "status": "done", "sent": 240, "failed": 4, "total": 244,
    "startedAt": "...", "finishedAt": "..." } ] }
```

With `people=1`, each row carries that person's lifetime state — `status`,
`followups`, `contacts`, `repliedAt`, `doNotContact` — because suppression
belongs to the person, not to a single send.

### `GET /api/campaigns?quota=<email>`

```json
{ "ok": true, "quota": { "sent": 340, "limit": 500 } }
```

Google enforces its own per-account daily sending cap — 500 recipients per
rolling 24 hours on a personal Gmail account, 2,000 on Workspace — and this
app has no control over it. `sent` counts delivered `sends` rows for that
address in the last 24 hours (a rolling window, not "since midnight," which
is how Gmail's own cap actually resets). This exists so a UI running several
accounts at once can show each one's remaining headroom up front, rather than
the first sign of trouble being a `SEND_QUOTA_EXCEEDED` in the middle of a
campaign.

### `POST /api/campaigns`

```json
{ "action": "start", "from": "me@gmail.com", "subject": "Hi {{name}}", "total": 50 }
→ { "ok": true, "campaignId": 12 }

{ "action": "finish", "campaignId": 12, "status": "done" }
→ { "ok": true }
```

Starts or closes out a campaign row. This exists because sending a fresh
(non-follow-up, non-imported) campaign previously had no code path that ever
called this — every `/api/send` in an ordinary compose-and-send campaign was
persisted with `campaign_id = NULL`. That silently broke two things: this
endpoint's own `GET` never listed the run, and `/api/followup` — which
requires a real campaign id — could never find anyone to chase for a
campaign sent the normal way. The browser now starts a campaign before its
send loop and finishes it after, exactly as `/api/followup` and `/api/import`
already do for their own runs.

`start` also takes an optional `groupKey` (any string). Sends are always
scoped to one account (`sends.sender`, `campaigns.from_email`), so mailing
several accounts at once from one "send" click still needs one campaign row
per account — but they were sent as one logical action, and `groupKey` is
what says so: every account's campaign in that action gets the same value,
so Section 5 can show them together without inventing cross-account send
rows that don't exist. `groupKey` is `null` for a campaign started the plain
single-account way; nothing generates one unless 2+ accounts are checked at
send time.

---

## `GET /api/thread?recipient=<id>`

The whole conversation with one person, oldest first. Sends and replies are
merged into one ordered trail:

```json
{ "ok": true, "trail": [
  { "type": "sent",     "round": 0, "label": "Initial email",          "at": "..." },
  { "type": "sent",     "round": 1, "label": "Follow-up 1",            "at": "..." },
  { "type": "sent",     "round": 2, "label": "Follow-up 2",            "at": "..." },
  { "type": "received", "repliesTo": 2, "label": "Replied to follow-up 2",
    "kind": "reply", "snippet": "Interested — who handles the west region?" } ] }
```

`repliesTo` is which round they answered, resolved from `In-Reply-To` against
the stored `message_id` — not inferred from dates.

---

## `GET /api/suppression`

Who must not be contacted, and who already has been. Returns **bare address
strings and nothing else**:

```json
{ "ok": true, "sent": ["a@b.com"], "blocked": ["c@d.com"],
  "replied": ["c@d.com"], "bounced": [] }
```

The browser only needs a set of strings to filter its list. Answering this with
full log rows meant shipping every stored body — roughly 12 MB per campaign
start against a 5 GB monthly transfer allowance.

---

## `GET /api/body?id=<send id>`

The exact HTML one recipient received, merge tags already resolved. One row per
call, fetched only when someone clicks View.

---

## `POST /api/send`

Sends **one** email. The browser loops over recipients and calls this once per
person, so each request stays well inside the serverless execution limit and
the UI gets live per-recipient progress.

```json
{
  "user": "me@gmail.com", "pass": "<app password>", "port": 587,
  "recipient": { "email": "a@b.com", "first": "Anita", "full": "Anita Sharma" },
  "subject": "Hi {{name}}", "greeting": "Hi {{name}},",
  "bodyHtml": "<p>…</p>", "closing": "Warm regards,",
  "attachments": [ { "filename": "a.pdf", "content": "<base64>" } ],
  "cc": "manager@company.com", "bcc": "archive@company.com",

  "campaignId": 12,
  "followupRound": 0,
  "inReplyTo": "<original@mail>",
  "references": ["<original@mail>"]
}
```

**Cc/Bcc are fixed for the whole run, not per-recipient.** Since this
endpoint sends one email to one person per call, `cc`/`bcc` here means "also
copy this address on every individual send in this campaign" (e.g. a manager
who wants every outreach copied to them) — not a second recipient sharing
one message with everyone else. Accepts anything nodemailer's own address
parser does: a single address, or several comma-separated in one string.
Passed straight through to `nodemailer`'s `sendMail()` as its own `cc`/`bcc`
options — no custom parsing on this side, confirmed against nodemailer's own
source (`lib/mailer/mail-message.js`), which treats `cc`/`bcc` identically to
`to` for address resolution. Omit either to send neither.

**Threading.** A follow-up is a reply in the original thread, not a new
message. Gmail nests it only when `inReplyTo` and `references` carry the
`Message-Id` of the message being answered — which is why every send persists
its own `message_id`.

`references` must be the **whole ancestor chain**, not just the immediate
parent (RFC 5322 §3.6.4: a message's References is its parent's References
plus the parent's own Message-Id). `/api/followup`'s candidates already carry
this pre-accumulated — a round 3 follow-up's `references` is `[round0Id,
round1Id, round2Id]`, not just `[round2Id]`. Sending only the immediate
parent was a real bug here: threading still worked for one round, and only
broke ancestry on the third, which is exactly the kind of thing that survives
testing against a single follow-up round and fails against a real chase
sequence.

**Duplicates.** A second send to the same person in the same campaign is
rejected by a UNIQUE index in the database, not by browser logic:

```json
{ "ok": false, "duplicate": true, "code": "SEND_DUPLICATE", "retry": "never" }
```

This holds even if two tabs run at once or a request is retried after a
timeout.

Response on success:

```json
{ "ok": true, "persisted": true,
  "entry": { "status": "sent", "messageId": "<x@mail>", "time": "..." } }
```

A delivery failure still returns HTTP 200 with `ok: false` — the request
succeeded, the delivery did not. `code` and `retry` say what to do next.

---

## `POST /api/verify`

Checks Gmail credentials over SMTP before a campaign starts.

```json
{ "user": "me@gmail.com", "pass": "<app password>", "port": 587 }
```

Port 465 is implicit TLS, 587 is STARTTLS. Both work with Gmail, but many
corporate networks block 465, so the port is a UI choice rather than a
constant. A failure returns `AUTH_REJECTED` or
`AUTH_APP_PASSWORD_REQUIRED`, both `retry: never`.

---

## `POST /api/replies`

Scans the inbox, classifies everything that arrived, matches it back to the
sends it answers, and updates suppression.

```json
{ "user": "me@gmail.com", "pass": "<app password>", "days": 30, "cursor": null }
```

**Resumable.** A hosted function is killed at 60s with no chance to clean up,
so the scan takes a ~40s budget, stops cleanly, and returns a `cursor`. The
browser calls again until `done` is true. A partial result you can continue
beats a timeout that loses the work.

```json
{ "ok": true, "examined": 244, "done": true, "cursor": null,
  "summary": { "reply": 18, "ooo": 6, "bounce": 4, "unsubscribe": 2 },
  "messages": [ { "kind": "reply", "from": "a@b.com", "matched": true,
                  "reason": "threaded human reply" } ] }
```

What each verdict does to the person is deliberately asymmetric:

| Verdict | Effect |
|---|---|
| reply · unsubscribe · hard bounce | `do_not_contact` — permanent |
| **out of office** | `ooo_until` — a **retry later**, not a block |
| soft bounce | one strike; suppressed on the third |

Treating an out-of-office as permanent suppression would quietly lose a live
contact, which is the costlier mistake.

---

## `GET|POST /api/followup`

`GET ?campaign=<id>` returns who is eligible and why:

```json
{ "ok": true, "counts": { "noreply": 212, "ooo": 4, "soft": 3, "failed": 4 },
  "candidates": [ { "email": "a@b.com", "why": "noreply",
                    "messageId": "<original@mail>" } ] }
```

`POST { campaignId, include, maxFollowups }` creates the follow-up run and
returns its `campaignId` plus the audience. Delivery then goes through
`/api/send` one person at a time, so a follow-up gets the same progress
reporting, error codes and duplicate protection as any campaign.

**Eligibility is decided server-side, at the moment of sending.** A page left
open for an hour has a stale idea of who has replied, and mailing someone who
already answered is the failure this whole system exists to prevent.

---

## `GET /api/resume?campaign=<id>`

What a stopped run still owes:

```json
{ "ok": true, "done": 80, "retry": [ { "email": "f@x.com", "first": "F" } ] }
```

The send loop runs in the browser tab and dies with it, so the remainder is
rebuilt from the database rather than trusted to the client. Anyone already
delivered to is excluded, and the UNIQUE index is the backstop if the same
person is somehow submitted twice.

---

## `POST /api/import`

Reads past campaigns back out of the Gmail Sent folder, so a follow-up can
thread onto mail sent before this tool existed.

Three actions, one pipeline:

| Action | Does |
|---|---|
| `scan` | Envelopes only, grouped into candidate campaigns with a confidence and a reason |
| `preview` | Bodies for the chosen messages; rebuilds the template and flags outliers |
| `commit` | Writes the campaign, every send carrying its original `Message-Id` |

Three ways in — search by subject/recipient, paste one email (`pasted`), or
auto-detect — all end at the same set of UIDs, so they share one pipeline
rather than being three features.

A campaign is recognised by **timing**, not subject alone: several recipients
seconds apart is a mail merge; the same subject hours apart is probably
individual correspondence, and is surfaced as `medium` confidence with the
reason attached rather than silently imported.

`commit` returns `nextStep: "scan-replies"`, because replies to an imported
campaign already exist in the inbox — until they are scanned, someone who
answered weeks ago is not yet suppressed.

### `commit` and multi-round threads

```json
{ "ok": true, "campaignId": 8, "rounds": 2, "added": 3, "skipped": 1,
  "nextStep": "scan-replies", "message": "..." }
```

If the chosen cluster includes more than one message to the SAME
recipient — someone who was manually chased once before this tool
existed — `commit` writes **one campaign per round**, chained by `parentId`
exactly the way a native follow-up chain already works (`api/followup.js`
does the same thing for a campaign sent through this tool). This is
required, not a stylistic choice: `sends(campaign_id, recipient_id)` is
UNIQUE, the same guard against double-sending someone in a single run — so
a person's original and their manual follow-up cannot both live in one
campaign row. `campaignId` in the response is the root (round 0) campaign;
`rounds` says how many were created. Each send still carries its own
`followup_round` and `in_reply_to_send`, computed by matching In-Reply-To/
References between the imported messages themselves — so `GET
/api/thread?recipient=<id>` renders the full multi-round conversation
correctly immediately after import, and a follow-up sent afterward threads
onto the latest round rather than the very first message.

### Finding a campaign by date range, subject-or-body text, or recipient

`scan` additionally accepts:

```json
{ "action": "scan", "user": "...", "pass": "...",
  "since": "2026-08-21", "until": "2026-08-26",
  "query": "great meeting at the event",
  "to": "person@company.com" }
```

| Field | Meaning |
|---|---|
| `since` / `until` | Plain `YYYY-MM-DD` calendar dates. Take priority over the older relative `days` lookback when given. |
| `query` | Free text searched against **subject OR body**, server-side, in the same IMAP round trip — not a separate fetch-and-filter pass. |
| `to` | Find every campaign ever sent to this recipient — an IMAP `TO` search, server-side. |

The response adds:

| Field | Meaning |
|---|---|
| `matchedVia` | Which of `subject`/`query`/`to`/`since`/`until` were actually part of this search, so a UI can say plainly what was and wasn't searched. |
| `bccCaveat` | `true` when `to` was used — see the caveat below. |
| `clusters[].bccInCluster` | This particular cluster (only present when `to` was used) contains at least one message with hidden recipients, so it may or may not actually include the person searched for. |

Four things worth knowing before relying on this:

- IMAP's `SINCE`/`BEFORE` disregard time-of-day and timezone entirely (RFC
  3501) — they compare calendar days only. `until` is pushed to the day
  *after* the one given, because `BEFORE` is exclusive: without that,
  "through today" would silently exclude anything sent today.
- `query` exists because subject matching alone misses real cases: "Great
  meeting at the event India Health 2026" and "Great meeting at the event"
  share no exact subject as strings — but as of the word-overlap upgrade to
  `lib/importer.js`'s `cluster()`, they now land in the same cluster on
  subject alone too (80%+ of the shorter subject's words present, in order,
  in the longer one); `query`'s server-side body search remains useful on
  top of that for campaigns whose subject varied more than a trailing
  fragment.
- `to` is an IMAP `TO` search: it matches the `To:` header only. A real BCC
  send never puts that address in any header a Sent-folder copy has to
  keep, so **`to` cannot find a purely-BCC'd recipient at all** — a search
  returning nothing does not mean that person was never contacted, only
  that they weren't in a `To:` line in this date range. `bccCaveat`/
  `bccInCluster` exist so a caller can say this plainly instead of letting
  "nothing found" read as "definitely never contacted."
- A cluster's confidence and reason (`lib/importer.js`) still speak to
  whether the group of messages looks like a real mail-merge burst, not to
  whether a `to` search actually named the person being searched for
  everywhere in that cluster — those are two independent questions.

---

## Libraries

| File | Responsibility |
|---|---|
| [`lib/store.js`](lib/store.js) | Postgres + SQLite, one interface. `recipients` is the de-duplication authority. |
| [`lib/errors.js`](lib/errors.js) | 24 error codes and the retry policy. |
| [`lib/classify.js`](lib/classify.js) | Is this a reply, an auto-responder, or a bounce? |
| [`lib/imap.js`](lib/imap.js) | Gmail IMAP, deadline-bounded and resumable. |
| [`lib/importer.js`](lib/importer.js) | Recognising past campaigns; rebuilding their template. |
| [`lib/log.js`](lib/log.js) | Structured logging with credential redaction. |
| [`lib/util.js`](lib/util.js) | Salutation parsing, merge-tag rendering, SMTP transport. |
| [`lib/llm.js`](lib/llm.js) | Optional DeepSeek-assisted fuzzy campaign matching, with exact per-call cost logging. |

### `lib/llm.js` — optional, and never authoritative

A last resort for the campaigns `lib/importer.js`'s exact-string clustering
and `/api/import`'s subject-or-body search both miss — e.g. one recipient's
subject carried an event name ("...at India Health 2026") and another's
didn't ("...at the event"). With no `DEEPSEEK_API_KEY` set, every function
in this file is a no-op returning `null`, and the deterministic clustering
result is the only thing that ran — nothing in the app's core behaviour
depends on this file.

When a key IS set, `/api/import`'s `scan` action runs a bounded, capped pass
(at most 20 pairwise comparisons, only against clusters already too
small/low-confidence for the deterministic path) and attaches
`mergeSuggestions` to affected clusters in the response — a suggestion the
user reads and acts on themselves, **never an automatic merge**.

Every call's exact cost is logged (`log.info('llm_usage', {...})`), computed
from the response's own `usage` object (`prompt_cache_hit_tokens` /
`prompt_cache_miss_tokens` / `completion_tokens`) against DeepSeek's
published per-token pricing, doubled during its own peak hours (01:00-04:00
and 06:00-10:00 UTC, Monday-Friday) — not assumed or estimated from token
counts alone, since a cache hit is roughly 31x cheaper than a cache miss on
`deepseek-v4-flash` and getting that wrong would make any cost estimate
meaningless.

Run `npm test` for the suite (130 tests). It uses SQLite by default so it needs
no network or secrets; set `DATABASE_URL` to run the same store tests against
Postgres. The `lib/llm.js` tests check the cost-calculation math against
DeepSeek's published pricing by hand arithmetic — no network call, no key
required.
