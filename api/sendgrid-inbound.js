'use strict';
/**
 * SendGrid Inbound Parse webhook — receives a reply the instant it lands on
 * reply.coherentconnect.ai and feeds it into the exact same recipient/reply
 * model the Gmail/IMAP side already uses (lib/store.js's recordReply and
 * lib/classify.js's classifyMessage), so a reply through SendGrid suppresses
 * future follow-ups exactly the same way an IMAP-detected reply does — not a
 * second, looser definition of "reply".
 *
 *   POST /api/sendgrid-inbound?key=<SENDGRID_INBOUND_SECRET>
 *
 * SendGrid POSTs multipart/form-data (not JSON) and cannot send our normal
 * auth header, so this endpoint is protected by a shared secret in the URL
 * itself instead — set on the SendGrid side when adding the Host & URL.
 *
 * Must always respond 200 quickly: SendGrid retries on non-2xx, and a slow or
 * failing endpoint gets Inbound Parse suspended for the whole account.
 */
const Busboy = require('busboy');
const store = require('../lib/store');
const { classifyMessage } = require('../lib/classify');
const log = require('../lib/log');

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const fields = {};
    const bb = Busboy({ headers: req.headers, limits: { fieldSize: 25 * 1024 * 1024 } });
    bb.on('field', (name, val) => { fields[name] = val; });
    bb.on('file', (name, stream) => { stream.resume(); }); // attachments: drained, not stored (for now)
    bb.on('error', reject);
    bb.on('finish', () => resolve(fields));
    req.pipe(bb);
  });
}

/* SendGrid's `headers` field is the raw RFC 5322 header block as one string.
   classifyMessage()/header() expect a plain {name: value} object (same shape
   ImapFlow's parsed headers take on the IMAP side), so parse it into one —
   passing the raw string through untouched would silently break every
   header() lookup (Object.keys() on a string gives numeric indices, not
   header names). */
function parseRawHeaders(raw) {
  const out = {};
  if (!raw) return out;
  // Unfold continuation lines (a header wrapped onto the next line starts
  // with whitespace) before splitting, or a folded value gets treated as
  // its own bogus header.
  const unfolded = String(raw).replace(/\r\n[ \t]+/g, ' ').replace(/\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const m = line.match(/^([^:]+):\s*(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

module.exports = log.wrap('sendgrid-inbound', async function handler(req, res) {
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(); }

  const secret = process.env.SENDGRID_INBOUND_SECRET;
  if (secret && (req.query || {}).key !== secret) {
    res.statusCode = 401;
    return res.end();
  }

  let fields;
  try {
    fields = await parseMultipart(req);
  } catch (e) {
    log.error('sendgrid_inbound_parse_failed', { error: String(e) });
    res.statusCode = 200; // still 200 — a malformed one-off should not trigger endless SendGrid retries
    return res.end();
  }

  const from = (fields.from || '').match(/<([^>]+)>/)?.[1] || fields.from || '';
  const headers = parseRawHeaders(fields.headers);
  const inReplyTo = headers['In-Reply-To'] ? headers['In-Reply-To'].match(/<[^>]+>/)?.[0] : null;
  const references = headers['References'] ? headers['References'].match(/<[^>]+>/g) || [] : [];

  const message = {
    from: from.trim().toLowerCase(),
    subject: fields.subject || '',
    text: fields.text || fields.html || '',
    headers,
    receivedAt: new Date().toISOString(),
    inReplyTo,
    references,
    mailbox: 'sendgrid-inbound',
  };

  /* Same classification the IMAP side runs — a bounce/OOO/unsubscribe/bulk
     mail landing here must not be counted as a real reply either. */
  const classification = classifyMessage(message, new Date());
  message.kind = classification.kind;
  message.oooUntil = classification.oooUntil;
  message.snippet = (fields.text || '').slice(0, 500);

  const result = await store.recordReply(message);
  log.info('sendgrid_inbound_received', {
    from: message.from, kind: message.kind, matched: result.matched, stored: result.stored,
  });

  res.statusCode = 200;
  res.end('OK');
});
