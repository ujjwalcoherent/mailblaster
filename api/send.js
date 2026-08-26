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
const { describe, httpFor, classify, CODES } = require('../lib/errors');
const log = require('../lib/log');
const auth = require('../lib/auth');

module.exports = log.wrap('send', auth.require(async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, describe('METHOD_NOT_ALLOWED'));

  const b = await readJson(req);
  const r = b.recipient || {};
  const fallback = b.fallbackName || 'there';

  if (!b.user || !b.pass) return send(res, 400, describe('AUTH_REQUIRED'));
  if (!r.email) return send(res, 400, describe('SEND_NO_RECIPIENT'));

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
    campaignId: b.campaignId || null,
    /* 0 for an original send, 1+ for each follow-up round, so a person's
       trail can say "replied to follow-up 2" rather than guessing. */
    followupRound: Number(b.followupRound || 0),
    from: b.user,
    to: r.email,
    name: r.first || fallback,
    fullName: r.full || '',
    confidence: r.confidence || null,
    fields: r.fields || null,
    subject,
    // only real attachments — the inline footer image isn't one
    attachments: (b.attachments || []).map(a => a.filename),
    status: 'failed',
    error: null,
    body: html,          // exactly what this person received, after merge tags
    /* Stored as the array the caller sent (RFC 5322 3.6.4's full ancestor
       chain), so the NEXT follow-up round can read it back via
       store.followupCandidates() and keep accumulating rather than
       collapsing to just the immediate parent. */
    references: Array.isArray(b.references) ? b.references : (b.references ? [b.references] : []),
  };

  const t = gmailTransport(nodemailer, b.user, b.pass, b.port);

  /* A follow-up is a reply in the ORIGINAL thread, not a new message: Gmail
     nests it under the first email only when both In-Reply-To and References
     carry the Message-Id of what it answers. The wire header is a
     space-joined string; what's persisted (entry.references, above) stays an
     array so it round-trips through JSON cleanly. */
  const inReplyTo = b.inReplyTo || undefined;
  const references = entry.references.length ? entry.references.join(' ') : inReplyTo;

  try {
    const info = await t.sendMail({
      from: b.fromName ? '"' + b.fromName + '" <' + b.user + '>' : b.user,
      to: r.email,
      cc: b.cc || undefined,
      bcc: b.bcc || undefined,
      subject,
      html,
      text: stripHtml(html),
      attachments,
      replyTo: b.replyTo || undefined,
      inReplyTo,
      references,
    });
    entry.status = 'sent';
    /* Persisted, not just returned: every future reply is matched back to this
       send by its Message-Id, so losing it would break reply detection. */
    entry.messageId = info.messageId || null;
  } catch (e) {
    entry.error = e.message;
    entry.code = classify(e);
    entry.retry = (CODES[entry.code] || {}).retry || 'never';
  } finally {
    try { t.close(); } catch (e) {}
  }

  /* The database rejects a second send to the same person in the same
     campaign, whatever the browser believes. A retried request therefore
     reports 'duplicate' instead of quietly mailing someone twice. */
  let persisted = false;
  try {
    persisted = await store.insert(entry);
  } catch (e) {
    log.error('persist_failed', { api: 'send', code: classify(e), message: e.message });
  }

  if (persisted === 'duplicate') {
    return send(res, 200, Object.assign(describe('SEND_DUPLICATE'), {
      ok: false, duplicate: true, entry, persisted: false,
    }));
  }

  if (entry.status !== 'sent') {
    log.warn('send_failed', { to: entry.to, code: entry.code, error: entry.error });
  }

  send(res, 200, {
    ok: entry.status === 'sent',
    entry,
    persisted: !!persisted,
    code: entry.code || null,
    retry: entry.retry || null,
  });
}));
