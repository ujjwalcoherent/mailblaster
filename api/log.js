'use strict';
/**
 * Read/clear the shared send log.
 *
 * Reports which driver is live so the UI can tell the user whether they are
 * looking at a shared history (postgres), a local file (sqlite), or only their
 * own browser copy (none).
 */
const { send } = require('../lib/util');
const store = require('../lib/store');
const logger = require('../lib/log');
const auth = require('../lib/auth');

module.exports = logger.wrap('log', auth.require(async function handler(req, res) {
  if (!(await store.available())) {
    return send(res, 200, { ok: true, available: false, driver: 'none', reason: store.reason(), rows: [] });
  }
  if (req.method === 'DELETE') {
    await store.clear();
    return send(res, 200, { ok: true, available: true, driver: store.driver(), rows: [] });
  }
  const owner = (req.query || {}).owner || '';
  send(res, 200, { ok: true, available: true, driver: store.driver(), rows: await store.list(2000, { owner }) });
}));
