'use strict';
/**
 * Scan the inbox for replies, out-of-office notices and bounces, match them
 * back to the sends they answer, and update suppression.
 *
 *   POST /api/replies   { user, pass, days, cursor }
 *
 * Resumable by design. A hosted function is killed at 60s with no chance to
 * clean up, so the scan takes a budget, stops early, and returns a cursor to
 * carry on with. A partial result the caller can continue beats a timeout that
 * loses the work.
 *
 * The App Password is used for this request and never stored.
 */
const { readJson, send } = require('../lib/util');
const store = require('../lib/store');
const imap = require('../lib/imap');
const { describe, httpFor, classify } = require('../lib/errors');
const log = require('../lib/log');
const auth = require('../lib/auth');

/* Leave headroom under the 60s function limit so the response still gets out. */
const BUDGET_MS = 40000;

module.exports = log.wrap('replies', auth.require(async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, describe('METHOD_NOT_ALLOWED'));

  const b = await readJson(req);
  if (!b.user || !b.pass) return send(res, 400, describe('AUTH_REQUIRED'));

  const days = Math.min(Math.max(Number(b.days) || 30, 1), 365);
  const since = new Date(Date.now() - days * 86400000);

  let scan;
  try {
    scan = await imap.scanReplies({
      user: b.user,
      pass: b.pass,
      since,
      cursor: b.cursor || null,
      deadline: Date.now() + BUDGET_MS,
    });
  } catch (e) {
    const code = classify(e);
    log.warn('imap_scan_failed', { code, message: e.message });
    return send(res, httpFor(code), describe(e));
  }

  /* Nothing is stored when there is no database: the classification is still
     returned so the browser can show it, but suppression cannot be durable. */
  const available = await store.available();
  const summary = { reply: 0, ooo: 0, bounce: 0, unsubscribe: 0, auto: 0 };
  const recorded = [];

  for (const m of scan.messages) {
    summary[m.kind] = (summary[m.kind] || 0) + 1;
    if (!available) { recorded.push(m); continue; }
    try {
      const saved = await store.recordReply(m);
      recorded.push(Object.assign({}, m, saved));
    } catch (e) {
      log.error('reply_persist_failed', { code: classify(e), message: e.message, uid: m.uid });
      recorded.push(m);
    }
  }

  log.info('reply_scan', {
    examined: scan.examined, matched: recorded.filter(r => r.matched).length,
    done: scan.done, days, summary,
  });

  send(res, 200, {
    ok: true,
    available,
    examined: scan.examined,
    total: scan.total || scan.examined,
    done: scan.done,
    cursor: scan.cursor,
    summary,
    messages: recorded,
  });
}));
