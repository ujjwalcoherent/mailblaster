'use strict';
/**
 * Read/clear the SQLite archive. Returns { available:false } wherever the
 * filesystem is read-only (e.g. Vercel) — the client then shows its
 * localStorage copy of the log instead.
 */
const { send } = require('../lib/util');
const store = require('../lib/store');

module.exports = async function handler(req, res) {
  if (!store.available()) {
    return send(res, 200, { ok: true, available: false, reason: store.reason(), rows: [] });
  }
  if (req.method === 'DELETE') {
    store.clear();
    return send(res, 200, { ok: true, available: true, rows: [] });
  }
  send(res, 200, { ok: true, available: true, rows: store.list(2000) });
};
