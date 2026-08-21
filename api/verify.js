'use strict';
const nodemailer = require('nodemailer');
const { readJson, send, gmailTransport } = require('../lib/util');
const { describe, httpFor, classify } = require('../lib/errors');
const log = require('../lib/log');
const auth = require('../lib/auth');

module.exports = log.wrap('verify', auth.require(async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, describe('METHOD_NOT_ALLOWED'));
  const { user, pass, port } = await readJson(req);
  if (!user || !pass) return send(res, 400, describe('AUTH_REQUIRED'));

  const t = gmailTransport(nodemailer, user, pass, port);
  try {
    await t.verify();
    send(res, 200, { ok: true, message: 'Gmail credentials verified on port ' + (Number(port) === 587 ? 587 : 465) });
  } catch (e) {
    const code = classify(e);
    send(res, httpFor(code), describe(e));
  } finally {
    try { t.close(); } catch (e) {}
  }
}));
