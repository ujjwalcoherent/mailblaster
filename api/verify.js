'use strict';
const nodemailer = require('nodemailer');
const { readJson, send } = require('../lib/util');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' });
  const { user, pass } = await readJson(req);
  if (!user || !pass) return send(res, 400, { ok: false, error: 'Gmail address and app password are required' });

  const t = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user, pass: String(pass).replace(/\s+/g, '') },
  });

  try {
    await t.verify();
    send(res, 200, { ok: true, message: 'Gmail credentials verified' });
  } catch (e) {
    send(res, 400, { ok: false, error: e.message });
  } finally {
    try { t.close(); } catch (e) {}
  }
};
