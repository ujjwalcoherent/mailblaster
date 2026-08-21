'use strict';
/**
 * What a stopped or interrupted campaign still owes.
 *
 *   GET /api/resume?campaign=12
 *
 * The send loop runs in the browser tab and dies with it, so a half-finished
 * run leaves no client-side record of where it got to. The remainder is
 * rebuilt from the database instead, and the UNIQUE index on
 * (campaign_id, recipient_id) is the backstop if the same person is somehow
 * submitted twice.
 */
const { send } = require('../lib/util');
const store = require('../lib/store');
const { describe, httpFor, classify } = require('../lib/errors');
const log = require('../lib/log');
const auth = require('../lib/auth');

module.exports = log.wrap('resume', auth.require(async function handler(req, res) {
  if (req.method !== 'GET') return send(res, 405, describe('METHOD_NOT_ALLOWED'));
  const id = (req.query || {}).campaign;
  if (!id) return send(res, 400, describe('BAD_REQUEST', { error: 'campaign id is required' }));
  if (!(await store.available())) return send(res, 200, { ok: true, available: false, retry: [] });

  try {
    const state = await store.campaignRemaining(id);
    send(res, 200, Object.assign({ ok: true, available: true }, state));
  } catch (e) {
    const code = classify(e);
    send(res, httpFor(code), describe(e));
  }
}));
