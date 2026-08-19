'use strict';
/**
 * Sends ONE email per request.
 *
 * The browser loops over the recipient list and calls this once per person, so
 * the function stays well inside a serverless execution limit and the UI gets
 * live per-recipient progress for free. No queue, no job state, no server.
 */
const nodemailer = require('nodemailer');
const { readJson, send, render, stripHtml, gmailTransport } = require('../lib/util');
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

  // attachments arrive as [{ filename, content: <base64> }]
  const attachments = (b.attachments || []).map(a => ({
    filename: a.filename,
    content: Buffer.from(a.content, 'base64'),
  }));

  /* Footer image (signature / banner).
     Sent as an inline CID attachment, not a data: URI — Gmail and Outlook
     both strip data-URI images, so base64 inline would render as a broken
     box for most recipients. */
  let imgTag = '';
  const fi = b.footerImage;
  if (fi && fi.content) {
    const cid = 'footerimg@mailblaster';
    const width = Math.max(40, Math.min(900, parseInt(b.footerImageWidth, 10) || 220));
    imgTag = '<img src="cid:' + cid + '" width="' + width + '" alt="" '
      + 'style="display:block;max-width:100%;width:' + width + 'px;height:auto;border:0;margin:10px 0"/>';
    if (b.footerImageLink) {
      imgTag = '<a href="' + String(b.footerImageLink).replace(/"/g, '&quot;') + '" target="_blank">' + imgTag + '</a>';
    }
    attachments.push({
      filename: fi.filename || 'signature.png',
      content: Buffer.from(fi.content, 'base64'),
      cid,
      contentDisposition: 'inline',
    });
  }

  const footerBlock = (b.footerImagePosition === 'above')
    ? imgTag + footer
    : footer + imgTag;

  const html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#1f2430">'
    + (greeting ? '<p>' + greeting + '</p>' : '')
    + body
    + (closing ? '<p style="white-space:pre-line">' + closing + '</p>' : '')
    + (footerBlock ? '<hr style="border:none;border-top:1px solid #e3e6ee;margin:18px 0"/>' + footerBlock : '')
    + '</div>';

  const entry = {
    time: new Date().toISOString(),
    from: b.user,
    to: r.email,
    name: r.first || fallback,
    subject,
    // only real attachments — the inline footer image isn't one
    attachments: (b.attachments || []).map(a => a.filename),
    status: 'failed',
    error: null,
    body: html,          // exactly what this person received, after merge tags
  };

  const t = gmailTransport(nodemailer, b.user, b.pass, b.port);

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
  try { persisted = await store.insert(entry); } catch (e) {}

  send(res, 200, { ok: entry.status === 'sent', entry, persisted });
};
