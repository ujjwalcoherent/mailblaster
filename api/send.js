'use strict';
/**
 * Sends ONE email per request.
 *
 * The browser loops over the recipient list and calls this once per person, so
 * the function stays well inside a serverless execution limit and the UI gets
 * live per-recipient progress for free. No queue, no job state, no server.
 */
const nodemailer = require('nodemailer');
const { readJson, send, render, stripHtml } = require('../lib/util');
const store = require('../lib/store');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' });

  const b = await readJson(req);
  const r = b.recipient || {};
  const fallback = b.fallbackName || 'there';

  if (!b.user || !b.pass) return send(res, 400, { ok: false, error: 'Missing Gmail credentials' });
  if (!r.email) return send(res, 400, { ok: false, error: 'Missing recipient' });

  const subject = render(b.subject || '(no subject)', r, fallback);
  const greeting = render(b.greeting || '', r, fallback);
  const body = render(b.bodyHtml || '', r, fallback);
  const closing = render(b.closing || '', r, fallback);
  const footer = render(b.footerHtml || '', r, fallback);

  const html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#1f2430">'
    + (greeting ? '<p>' + greeting + '</p>' : '')
    + body
    + (closing ? '<p style="white-space:pre-line">' + closing + '</p>' : '')
    + (footer ? '<hr style="border:none;border-top:1px solid #e3e6ee;margin:18px 0"/>' + footer : '')
    + '</div>';

  // attachments arrive as [{ filename, content: <base64> }]
  const attachments = (b.attachments || []).map(a => ({
    filename: a.filename,
    content: Buffer.from(a.content, 'base64'),
  }));

  const entry = {
    time: new Date().toISOString(),
    from: b.user,
    to: r.email,
    name: r.first || fallback,
    subject,
    attachments: attachments.map(a => a.filename),
    status: 'failed',
    error: null,
  };

  const t = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: b.user, pass: String(b.pass).replace(/\s+/g, '') },
  });

  try {
    const info = await t.sendMail({
      from: b.fromName ? '"' + b.fromName + '" <' + b.user + '>' : b.user,
      to: r.email,
      subject,
      html,
      text: stripHtml(html),
      attachments,
      replyTo: b.replyTo || undefined,
    });
    entry.status = 'sent';
    entry.messageId = info.messageId;
  } catch (e) {
    entry.error = e.message;
  } finally {
    try { t.close(); } catch (e) {}
  }

  let persisted = false;
  try { persisted = store.insert(entry); } catch (e) {}

  send(res, 200, { ok: entry.status === 'sent', entry, persisted });
};
