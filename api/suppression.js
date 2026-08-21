'use strict';
/**
 * Who must not be contacted, and who has already been.
 *
 * Returns bare addresses and nothing else. The browser only needs a set of
 * strings to filter its recipient list, and answering that question with full
 * log rows meant shipping every stored email body — megabytes per campaign
 * start, against a 5 GB monthly transfer allowance.
 */
const { send } = require('../lib/util');
const store = require('../lib/store');
const { describe, httpFor, classify } = require('../lib/errors');
const log = require('../lib/log');
const auth = require('../lib/auth');

module.exports = log.wrap('suppression', auth.require(async function handler(req, res) {
  if (req.method !== 'GET') return send(res, 405, describe('METHOD_NOT_ALLOWED'));
  if (!(await store.available())) {
    return send(res, 200, { ok: true, available: false, sent: [], blocked: [], replied: [], bounced: [] });
  }
  try {
    const s = await store.suppression((req.query || {}).owner);
    send(res, 200, Object.assign({ ok: true, available: true }, s));
  } catch (e) {
    const code = classify(e);
    send(res, httpFor(code), describe(e));
  }
}));
