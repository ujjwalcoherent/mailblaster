'use strict';
/**
 * Campaign history for one Gmail account, and the people inside one campaign.
 *
 *   GET /api/campaigns?owner=me@gmail.com          -> the runs
 *   GET /api/campaigns?id=12&people=1              -> who was in run 12
 *
 * Scoped by the sending address so signing in with a Gmail account shows that
 * account's history. Only the address is used: the App Password never reaches
 * the server.
 */
const { send } = require('../lib/util');
const store = require('../lib/store');
const { describe, httpFor, classify } = require('../lib/errors');
const log = require('../lib/log');
const auth = require('../lib/auth');

module.exports = log.wrap('campaigns', auth.require(async function handler(req, res) {
  if (req.method !== 'GET') return send(res, 405, describe('METHOD_NOT_ALLOWED'));
  if (!(await store.available())) return send(res, 200, { ok: true, available: false, campaigns: [], reason: store.reason() });

  const q = req.query || {};
  try {
    if (q.people && q.id) {
      const people = await store.campaignPeople(q.id);
      return send(res, 200, { ok: true, available: true, people });
    }
    const campaigns = await store.campaigns(q.owner, q.limit);
    send(res, 200, { ok: true, available: true, driver: store.driver(), campaigns });
  } catch (e) {
    const code = classify(e);
    send(res, httpFor(code), describe(e));
  }
}));
