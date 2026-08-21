'use strict';
/**
 * The whole conversation with one person, oldest first:
 * initial -> follow-up 1 -> reply -> follow-up 2 ...
 *
 *   GET /api/thread?recipient=42
 */
const { send } = require('../lib/util');
const store = require('../lib/store');
const { describe, httpFor, classify } = require('../lib/errors');
const log = require('../lib/log');
const auth = require('../lib/auth');

module.exports = log.wrap('thread', auth.require(async function handler(req, res) {
  if (req.method !== 'GET') return send(res, 405, describe('METHOD_NOT_ALLOWED'));
  const id = (req.query || {}).recipient;
  if (!id) return send(res, 400, describe('BAD_REQUEST', { error: 'recipient id is required' }));
  if (!(await store.available())) return send(res, 200, { ok: true, available: false, trail: [] });

  try {
    send(res, 200, { ok: true, available: true, trail: await store.thread(id) });
  } catch (e) {
    const code = classify(e);
    send(res, httpFor(code), describe(e));
  }
}));
