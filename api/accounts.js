'use strict';
/**
 * Saved Gmail accounts, so an app password is entered once and never again —
 * on any browser, any device, after a successful Verify.
 *
 *   GET    /api/accounts            -> list, WITHOUT passwords
 *   GET    /api/accounts?email=x&reveal=1  -> one account WITH its decrypted password
 *   POST   /api/accounts { email, password, fromName, replyTo, smtpPort, autoScanOnSend }
 *   DELETE /api/accounts?email=x
 *
 * `reveal` is separate from the list call on purpose: the compact card list
 * (rendered on every load) never needs to decrypt anything, so a stolen
 * response body from that call alone cannot leak a password. Only the one
 * moment the app is about to open an SMTP/IMAP connection asks for it.
 */
const { readJson, send } = require('../lib/util');
const store = require('../lib/store');
const cryptoBox = require('../lib/crypto');
const { describe, httpFor, classify } = require('../lib/errors');
const log = require('../lib/log');
const auth = require('../lib/auth');

module.exports = log.wrap('accounts', auth.require(async function handler(req, res) {
  if (!(await store.available())) return send(res, 503, describe('DB_UNAVAILABLE'));
  if (!cryptoBox.available()) {
    return send(res, 503, {
      ok: false, code: 'ACCOUNTS_ENCRYPTION_KEY_MISSING',
      error: 'Saved accounts require ACCOUNTS_ENCRYPTION_KEY to be set on the server.',
      hint: 'Set ACCOUNTS_ENCRYPTION_KEY (a random 64-char hex string) in your Vercel project settings.',
      retry: 'never',
    });
  }

  try {
    if (req.method === 'GET') return await get(req, res);
    if (req.method === 'POST') return await post(req, res);
    if (req.method === 'DELETE') return await del(req, res);
    return send(res, 405, describe('METHOD_NOT_ALLOWED'));
  } catch (e) {
    const code = classify(e);
    log.warn('accounts_failed', { method: req.method, code, message: e.message });
    send(res, httpFor(code), describe(e));
  }
}));

async function get(req, res) {
  const q = req.query || {};
  if (q.email && q.reveal) {
    const a = await store.loadAccount(q.email);
    if (!a) return send(res, 404, { ok: false, error: 'No saved account for that address.' });
    return send(res, 200, { ok: true, account: a });
  }
  const accounts = await store.listAccounts();
  send(res, 200, { ok: true, accounts });
}

async function post(req, res) {
  const b = await readJson(req);
  if (!b.email || !b.password) return send(res, 400, describe('BAD_REQUEST', { error: 'email and password are required' }));
  await store.saveAccount({
    email: b.email, password: b.password, fromName: b.fromName,
    replyTo: b.replyTo, smtpPort: b.smtpPort, autoScanOnSend: b.autoScanOnSend,
  });
  send(res, 200, { ok: true });
}

async function del(req, res) {
  const q = req.query || {};
  if (!q.email) return send(res, 400, describe('BAD_REQUEST', { error: 'email is required' }));
  await store.deleteAccount(q.email);
  send(res, 200, { ok: true });
}
