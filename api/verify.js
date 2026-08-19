'use strict';
const nodemailer = require('nodemailer');
const { readJson, send, gmailTransport } = require('../lib/util');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' });
  const { user, pass, port } = await readJson(req);
  if (!user || !pass) return send(res, 400, { ok: false, error: 'Gmail address and app password are required' });

  const t = gmailTransport(nodemailer, user, pass, port);
  try {
    await t.verify();
    send(res, 200, { ok: true, message: 'Gmail credentials verified on port ' + (Number(port) === 587 ? 587 : 465) });
  } catch (e) {
    send(res, 400, { ok: false, error: e.message, code: e.code || null });
  } finally {
    try { t.close(); } catch (e) {}
  }
};
