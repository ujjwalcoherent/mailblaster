'use strict';
/**
 * Read past campaigns back out of the Gmail Sent folder.
 *
 *   POST /api/import { action: 'scan',    user, pass, days, since, until, subject, query, to, pasted, cursor }
 *   POST /api/import { action: 'preview', user, pass, mailbox, uids }
 *   POST /api/import { action: 'commit',  user, pass, mailbox, uids, name }
 *
 * `since`/`until` are plain "YYYY-MM-DD" calendar dates and take priority
 * over the older relative `days` lookback when given, so "21 Aug 2026 to
 * today" can be expressed directly rather than approximated by a day count.
 * `query` searches subject OR body text, server-side, in the same IMAP
 * round trip — not a separate fetch-and-filter pass — which is what lets a
 * loose fragment like "great meeting at the event" find both "...India
 * Health 2026" and the bare version someone sent without the event name.
 *
 * The point is threading: a follow-up can only nest under the original if we
 * know that original's Message-Id, and the Sent folder is the only place it
 * exists for mail this tool did not send.
 *
 * Three ways in — search, paste one email, auto-detect — all end at the same
 * place: a set of UIDs. So scan/preview/commit is one pipeline rather than
 * three separate features.
 */
const { readJson, send, parseName } = require('../lib/util');
const store = require('../lib/store');
const imap = require('../lib/imap');
const { cluster, parsePasted, rebuildTemplate } = require('../lib/importer');
const { describe, httpFor, classify } = require('../lib/errors');
const log = require('../lib/log');
const auth = require('../lib/auth');

const BUDGET_MS = 40000;

module.exports = log.wrap('import', auth.require(async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, describe('METHOD_NOT_ALLOWED'));
  const b = await readJson(req);
  if (!b.user || !b.pass) return send(res, 400, describe('AUTH_REQUIRED'));

  try {
    if (b.action === 'scan') return await scan(b, res);
    if (b.action === 'preview') return await preview(b, res);
    if (b.action === 'commit') return await commit(b, res);
    return send(res, 400, describe('BAD_REQUEST', { error: 'action must be scan, preview or commit' }));
  } catch (e) {
    const code = classify(e);
    log.warn('import_failed', { action: b.action, code, message: e.message });
    send(res, httpFor(code), describe(e));
  }
}));

/* Envelopes only: a Sent folder can hold tens of thousands of messages, and
   fetching bodies just to draw a list would be slow and pointless. */
async function scan(b, res) {
  let subject = b.subject || null;

  /* "Paste an email" is the same scan, seeded from whatever headers the paste
     contained — a Message-Id if we are lucky, the subject line if not. */
  let pasted = null;
  if (b.pasted) {
    pasted = parsePasted(b.pasted);
    if (!pasted.usable) {
      return send(res, 400, describe('BAD_REQUEST', {
        error: 'Could not find a subject or Message-Id in that text.',
      }));
    }
    subject = subject || pasted.subject;
  }

  /* Two ways to say "how far back": an explicit date range (b.since/b.until,
     e.g. "21 Aug 2026 to today"), or the older relative b.days lookback.
     Explicit dates win when given. IMAP's BEFORE is exclusive of time, so
     "through today" needs the day AFTER b.until (or today's own sends are
     silently excluded) — that adjustment happens here, once, rather than
     asking every caller to remember it. b.since/b.until are plain
     "YYYY-MM-DD" calendar dates from a UI date picker, not timezone-shifted
     ISO instants: IMAP SINCE/BEFORE disregard time-of-day and timezone
     entirely (RFC 3501), comparing only the calendar day, so there's nothing
     to convert — but a JS Date built from a timestamp instead of a bare
     calendar date can land on the wrong day depending on the caller's local
     offset, which is exactly the bug this plain-string convention avoids. */
  let since, until;
  if (b.since) {
    since = new Date(b.since + 'T00:00:00Z');
  } else {
    const days = Math.min(Math.max(Number(b.days) || 90, 1), 3650);
    since = new Date(Date.now() - days * 86400000);
  }
  if (b.until) {
    const endDay = new Date(b.until + 'T00:00:00Z');
    until = new Date(endDay.getTime() + 86400000);   // BEFORE is exclusive: push to the next day
  }

  const result = await imap.scanSent({
    user: b.user, pass: b.pass,
    since, until,
    subject, query: b.query || null, to: b.to || null,
    cursor: b.cursor || null,
    deadline: Date.now() + BUDGET_MS,
  });

  const clusters = cluster(result.messages);

  /* Anything already imported, or sent by this tool, must not be offered
     again: re-importing would double every recipient's history. */
  let known = new Set();
  if (await store.available()) known = new Set(await store.knownMessageIds());
  clusters.forEach(c => {
    c.alreadyImported = c.messageIds.filter(id => known.has(id)).length;
  });

  log.info('import_scan', {
    mailbox: result.mailbox, examined: result.examined,
    clusters: clusters.length, done: result.done,
  });

  send(res, 200, {
    ok: true, mailbox: result.mailbox, examined: result.examined,
    total: result.total, done: result.done, cursor: result.cursor,
    pasted, clusters,
  });
}

/* Bodies for the chosen messages only, so the template can be rebuilt and
   shown for confirmation before anything is written. */
async function preview(b, res) {
  const uids = (b.uids || []).slice(0, 12);        // a handful is plenty to diff
  if (!uids.length) return send(res, 400, describe('BAD_REQUEST', { error: 'uids are required' }));

  const samples = await imap.fetchBodies({
    user: b.user, pass: b.pass, mailbox: b.mailbox, uids,
  });
  const rebuilt = rebuildTemplate(samples);

  send(res, 200, {
    ok: true,
    template: rebuilt.template,
    fields: rebuilt.fields,
    outliers: rebuilt.outliers,
    confidence: rebuilt.confidence,
    note: rebuilt.note,
    samples: samples.map(s => ({ uid: s.uid, to: s.to, subject: s.subject, at: s.at })),
  });
}

/* Write the campaign. Every send is marked imported and carries its original
   Message-Id, which is what makes a threaded follow-up possible. */
async function commit(b, res) {
  if (!(await store.available())) return send(res, 503, describe('DB_UNAVAILABLE'));
  const uids = b.uids || [];
  if (!uids.length) return send(res, 400, describe('BAD_REQUEST', { error: 'uids are required' }));

  const messages = await imap.fetchBodies({
    user: b.user, pass: b.pass, mailbox: b.mailbox, uids,
  });
  if (!messages.length) return send(res, 404, { ok: false, error: 'Nothing found for those messages' });

  messages.sort((a, c) => String(a.at).localeCompare(String(c.at)));
  const first = messages[0];
  const recipients = messages.reduce((n, m) => n + Math.max(1, m.to.length), 0);

  const campaignId = await store.startCampaign({
    name: b.name || first.subject || 'Imported campaign',
    subject: first.subject,
    from: b.user,
    total: recipients,
    imported: true,
    importSource: b.source || 'search',
    startedAt: first.at,
  });

  let added = 0, skipped = 0;
  for (const m of messages) {
    const to = m.to.length ? m.to : [null];
    for (const address of to) {
      if (!address) { skipped++; continue; }      // BCC blast: recipients are hidden
      const r = await store.insert({
        campaignId,
        time: m.at,
        from: b.user,
        to: address,
        name: parseName(address).first || '',
        subject: m.subject,
        attachments: m.attachments,
        status: 'sent',
        body: m.body,
        messageId: m.messageId,
        imported: true,
      });
      if (r === 'duplicate') skipped++; else added++;
    }
  }
  await store.finishCampaign(campaignId, 'done');

  log.info('import_commit', { campaignId, added, skipped });

  send(res, 200, {
    ok: true, campaignId, added, skipped,
    /* Replies to this campaign already exist in the inbox. Until they are
       scanned, anyone who answered weeks ago is not yet suppressed — which is
       exactly who must not receive a follow-up. */
    nextStep: 'scan-replies',
    message: 'Imported. Scan for replies before sending a follow-up, so people who already answered are excluded.',
  });
}
