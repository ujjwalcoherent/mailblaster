'use strict';
/**
 * The exact HTML one recipient received.
 *
 * Fetched one row at a time, on demand, because a stored body is several KB
 * and only ever read when someone clicks View.
 */
const { send } = require('../lib/util');
const store = require('../lib/store');
const { describe, httpFor, classify } = require('../lib/errors');
const log = require('../lib/log');
const auth = require('../lib/auth');

module.exports = log.wrap('body', auth.require(async function handler(req, res) {
  if (req.method !== 'GET') return send(res, 405, describe('METHOD_NOT_ALLOWED'));
  const id = (req.query || {}).id;
  if (!id) return send(res, 400, describe('BAD_REQUEST', { error: 'id is required' }));
  try {
    const body = await store.body(id);
    if (body == null) return send(res, 404, { ok: false, error: 'Not found' });
    send(res, 200, { ok: true, body });
  } catch (e) {
    const code = classify(e);
    send(res, httpFor(code), describe(e));
  }
}));
