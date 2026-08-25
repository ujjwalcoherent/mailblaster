# Architecture

Written for whoever picks this up next — human or agent. It explains not just
where things are, but why they are that shape, because most of the decisions
here are reactions to a specific failure mode.

---

## The one idea

**A person, not a send, is the unit of truth.**

`recipients` holds one row per email address, ever, carrying lifetime state:
have they replied, bounced, unsubscribed, are they on holiday, how many times
have we chased them. Campaigns and sends reference that row.

Everything else follows. "Don't email someone who already replied" becomes a
single indexed lookup rather than a scan across history, and the answer stays
correct across campaigns, devices and months.

---

## Layers

```
browser            index.html · app.js · style.css
                   holds credentials, runs the send loop
                          │  one HTTP call per recipient
                          ▼
endpoints          api/*.js — thin: validate, call a lib, shape a response
                          ▼
libraries          lib/store.js     database, both drivers
                   lib/imap.js      Gmail IMAP, deadline-bounded
                   lib/classify.js  reply vs auto-reply vs bounce
                   lib/importer.js  recognising past campaigns
                   lib/errors.js    24 codes + retry policy
                   lib/log.js       structured logging, redaction
                   lib/util.js      salutation parsing, SMTP transport
                          ▼
data               Neon Postgres (hosted) · SQLite (local)
```

Endpoints stay thin on purpose: every piece of judgement lives in a library
that can be tested without a network, a mailbox or a database. That is why
`npm test` runs 74 tests in a second with no secrets.

---

## Data model

```
campaigns ──┬──< sends >──┬── recipients ──< replies
            │             │      ▲
   parent_id│    message_id      │ do_not_contact
   (a follow-up          │       │ ooo_until
    points at the        └───────┘ followup_count
    run it chases)     matched by In-Reply-To
```

### Why `message_id` matters more than it looks

`sends.message_id` is the SMTP Message-Id Gmail assigned. It is the hinge of
the whole system:

- A reply carries it in `In-Reply-To`, which is how an inbound message is tied
  back to the exact send it answers — surviving forwards and aliases, which a
  From-address match does not.
- A follow-up must repeat it in `In-Reply-To` and `References`, or Gmail shows
  the follow-up as an unrelated new email instead of nesting it in the thread.

It was being generated and silently discarded before the column existed. Losing
it breaks reply detection and threading at once.

### The three UNIQUE constraints

These are the safety mechanism, and they are in the database rather than in
JavaScript because the browser cannot be trusted: the send loop lives in a tab
that can be duplicated, reloaded or left open for an hour.

| Constraint | Prevents |
|---|---|
| `recipients.email` | Two identities for one person (addresses are lowercased on write) |
| `sends(campaign_id, recipient_id)` | The same person being mailed twice in one campaign |
| `replies(mailbox, imap_uid)` | A re-scan duplicating messages |

A rejected duplicate is reported as `'duplicate'`, not thrown — it is an
expected outcome of a retry, not an error.

### Migrations

Every statement in `lib/schema.sql` is `IF NOT EXISTS` or `ADD COLUMN IF NOT
EXISTS`, and the file is executed on each cold start. A `git push` therefore
migrates the live database on the first request after deploy, with no manual
step and no downtime.

This pattern handles *adding* safely. It cannot express a rename or a type
change — those need a real migration, so the schema is deliberately
additive-only.

---

## Decisions worth understanding

### Sending is one HTTP request per recipient

The browser loops. Each request stays far inside the serverless execution
limit, the UI gets live per-recipient progress for free, and there is no queue
or job state to manage.

The cost: the campaign dies if the tab closes. That is why `beforeunload`
warns, and why **resume rebuilds the remainder from the database** rather than
from anything the client remembered.

### Classification order is not the obvious one

An out-of-office *is* a reply mechanically — same thread, carries
`In-Reply-To`. A bounce usually carries it too. So `lib/classify.js` checks in
this order, first match wins:

```
1. bounce        mailer-daemon, multipart/report, X-Failed-Recipients
2. auto / OOO    Auto-Submitted, X-Auto*, subject, first-person body
3. unsubscribe   explicit opt-out language
4. bulk          List-Id, Precedence: bulk
5. human reply   everything left that threads onto one of our sends
```

Reversing it would file every auto-responder as engagement.

**Body matching is deliberately conservative.** A human replying *"I was out of
office last week, sorry for the delay — very interested!"* must not be filed as
a vacation responder, or a live prospect silently drops out of every follow-up.
So body patterns require a first-person present-tense statement near the start
of the message. This was a real bug, found by testing against realistic replies
rather than synthetic ones.

### Consequences are asymmetric on purpose

| Verdict | Effect | Why |
|---|---|---|
| reply, unsubscribe, hard bounce | `do_not_contact` permanently | Emailing again is harmful |
| **out of office** | `ooo_until` — retry after that date | They never saw it; suppressing loses a live contact |
| soft bounce | one strike, suppressed at three | A full mailbox usually clears |

The costlier mistake is losing a real contact, so ambiguity resolves toward
keeping them.

### `retry` is a property of the error

`lib/errors.js` maps every failure to one of three policies:

- **`auto`** — transient; retried with exponential backoff.
- **`confirm`** — *may already have succeeded*; the UI asks.
- **`never`** — retrying cannot help or actively harms.

`SEND_TIMEOUT` is `confirm`, not `auto`: Gmail may have accepted the message
before the socket dropped, so a silent retry sends it twice. (The UNIQUE index
is the backstop if someone retries anyway.)

Auth failures are `never`, because Google locks an account after repeated bad
logins — the naive retry actively makes things worse.

### IMAP work is deadline-bounded and resumable

A Vercel function is killed at its limit with no chance to clean up. So every
scan takes a time budget (~40s of a 60s limit), stops cleanly when it runs out,
and returns a cursor. The browser calls again until `done`.

A partial result the caller can continue beats a timeout that loses the work.

### Two efficiency decisions that shaped the API

**Bodies are never shipped in a list.** `/api/log` returns metadata;
`/api/body?id=` fetches one body when someone clicks View. A stored body is
several KB of HTML and is only ever read one at a time.

**`/api/suppression` returns bare strings.** The browser needs a set of
addresses to filter its list. Answering that with full log rows meant ~12 MB
per campaign start against a 5 GB monthly transfer allowance — roughly 400
campaign starts before the free tier was exhausted. Now ~20 KB.

### Credentials never reach the server's storage

The App Password is sent per request, used, and dropped. Only the sending
address is persisted, as the key that scopes history to an account.

This is why reply scanning is a button rather than a cron job: a schedule would
require storing the password server-side permanently. (Vercel's Hobby plan also
caps cron at one run per day, so hourly polling is not available free anyway.)

The scan is manual, on purpose, not automatic at campaign start: an earlier
draft of this doc claimed campaign start triggered a scan, but that was never
implemented, and — on reflection — shouldn't be implicit. Auto-scanning would
add a network round trip (and a new failure mode: what happens if the scan
itself times out?) before every send, silently, which cuts against the rest of
this codebase's philosophy of making cost and risk visible rather than hidden.
The compensating design is instead a clearly-labelled "Scan for replies" button
placed right next to "Send follow-up," so refreshing suppression immediately
before sending is one deliberate click away, not a hidden precondition.

---

## Importing campaigns sent before this tool

A user who already ran a campaign by hand can still follow up in-thread,
because their Sent folder holds everything needed — recipients, subject, body,
timestamps and the Message-Ids.

Three ways in — search, paste one email, auto-detect — all resolve to the same
thing, **a set of UIDs**, so they share one pipeline (`scan → preview →
commit`) rather than being three features.

**A campaign is recognised by timing, not subject alone.** A mail merge sends
seconds apart; a person writing five emails takes minutes. Several recipients
with a median gap under two minutes is `high` confidence; the same subject
hours apart is `medium`, surfaced with the reason attached rather than silently
imported.

**The template is rebuilt by diffing bodies.** What is identical everywhere is
the template; what varies is a merge field. A fragment is only called
`{{name}}` when it matches the name parsed from that recipient's address —
anything else becomes `{{?}}` for the user to name. The system does not guess.

One unrelated email sharing a subject would otherwise make every token look
variable and reduce the template to noise, so outliers are found against the
majority shape and set aside first — then reported, never silently dropped.

---

## Testing

`npm test` — 74 tests, SQLite by default so it needs no network or secrets.
Set `DATABASE_URL` to run the same store tests against Postgres; both must
pass, and the drivers are expected to behave identically.

The store tests are written as invariants, not implementation checks —
`THE GUARD: the same person cannot be sent twice in one campaign` fails loudly
if the constraint is ever dropped.

The frontend is verified by executing `app.js` in jsdom: it must run without
throwing, mount both mail windows, and leave no button without a handler. This
caught a real crash where one stale element id threw during load and left every
handler after it unbound — which presented as "nothing works".

---

## Known gaps

- **IMAP paths are untested against a live mailbox.** Every unit is tested with
  fixtures, but no real Gmail scan has run.
- **No import UI.** The endpoint works; nothing drives it yet.
- **Sections 1 and 2 predate the visual rework** in 3, 4 and 5.
