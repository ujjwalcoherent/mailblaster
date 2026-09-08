# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Read first

This repo documents itself in depth — read these before making changes, they are not optional context:

- [README.md](README.md) — what the app does, the five UI sections, deploy
- [ARCHITECTURE.md](ARCHITECTURE.md) — **why** things are shaped this way; each decision is a reaction to a specific real bug or cost
- [CONTRIBUTING.md](CONTRIBUTING.md) — invariants you must not break, conventions, traps that already caught someone
- [API.md](API.md) — every endpoint's request/response shape

Do not re-derive what those files already explain. This file only adds what they don't cover.

## Commands

```bash
npm install
npm start                                    # http://localhost:3000, SQLite (data/mail.db)
PORT=3100 npm start                          # alternate port
npm test                                     # full suite, SQLite, no network/secrets needed
DATABASE_URL="postgres://...pooler..." node test.js   # same suite against Postgres — must also pass
```

No build step, no bundler, no linter config. `node --check <file>` catches syntax errors when you can't run the full suite.

There is no single-test-file runner — `test.js` is one file; run it whole.

## Architecture in one paragraph

Static frontend (`index.html` + `app.js`, no framework) drives thin serverless endpoints (`api/*.js`: validate, call a lib, shape a response) backed by libraries in `lib/` that hold all real judgement and are unit-testable with no network. Two interchangeable store drivers — Postgres (`@neondatabase/serverless`, hosted) and SQLite (`node:sqlite`, local dev only — Vercel's filesystem is read-only) — must behave identically; `lib/store.js` implements both. **A person, not a send, is the unit of truth**: `recipients` holds one row per address forever, and three UNIQUE constraints in the database (never the browser) enforce no-double-send, no-duplicate-reply-import, and one-identity-per-address. See ARCHITECTURE.md for the full data model and the reasoning behind each of the above.

## Working in this codebase

- Schema changes are additive-only (`IF NOT EXISTS`) in **both** `lib/schema.sql` and the SQLite mirror inside `lib/store.js` — they must stay in step.
- New endpoints follow the existing thin-handler shape: `log.wrap('name', auth.require(async (req, res) => { ... }))`, errors via `lib/errors.js`'s `describe()`/`classify()`/`httpFor()`, never an ad-hoc error shape.
- Frontend ids: both mail windows clone from `#mailWindowTpl`; add a field there, never to one window only, or the two windows drift. Bind handlers defensively (`if ($(id)) $(id).addEventListener(...)`) — one unguarded missing element throws mid-load and silently leaves every later handler unbound.
- `sends.message_id` must always be persisted — reply threading depends on it and it has been silently dropped once already.
- Credentials: the App Password is per-request by original design (README/ARCHITECTURE both state "never stored server-side"). A later addition (`api/accounts.js`, `lib/crypto.js`, the `accounts` table) does now persist it **encrypted** (AES-256-GCM, key from `ACCOUNTS_ENCRYPTION_KEY`) as an opt-in convenience so Verify is a one-time step across devices — this contradicts the original docs' "never stored server-side" claim and those docs have not been updated to reflect it.
- The duplicate-send guard reserves the `(campaign_id, recipient_id)` row **before** calling Gmail's SMTP (`store.reserveSend()` → send → `store.finalizeSend()`), not after — reserving after the SMTP call, the original shape, only prevented a duplicate database row, not a duplicate email.
