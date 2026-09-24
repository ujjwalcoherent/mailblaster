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
 * No multipart-parsing library: this repo is deliberately dependency-light
 * (see README/CLAUDE.md — "no framework, no build step"), and SendGrid's
 * Parse payload is a small, fixed set of plain-text fields (from, to,
 * subject, text, html, headers, envelope, spam_score) — attachments are the
 * only binary parts, and this endpoint doesn't need them, so a full
 * multipart library is more risk (exactly the extra dependency that broke
 * the last two deployments — see git history) than a ~30-line parser scoped
 * to this one known shape.
 *
 * Must always respond 200 quickly: SendGrid retries on non-2xx, and a slow
 * or failing endpoint gets Inbound Parse suspended for the whole account.
 */
const store = require('../lib/store');
const { classifyMessage } = require('../lib/classify');
const log = require('../lib/log');

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/* Text-field-only multipart/form-data parser. Any part whose Content-Disposition
   carries a filename= (i.e. an attachment) is skipped entirely — this endpoint
   only needs the plain-text fields SendGrid always sends alongside them. */
function parseMultipartFields(buf, boundary) {
  const fields = {};
  const delim = Buffer.from('--' + boundary);
  let start = buf.indexOf(delim);
  while (start !== -1) {
    const next = buf.indexOf(delim, start + delim.length);
    if (next === -1) break;
    const part = buf.slice(start + delim.length, next);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const headerText = part.slice(0, headerEnd).toString('utf8');
      const nameMatch = headerText.match(/name="([^"]+)"/);
      const isFile = /filename="/.test(headerText);
      if (nameMatch && !isFile) {
        let value = part.slice(headerEnd + 4);
        // strip the trailing CRLF that precedes the next boundary
        if (value.slice(-2).toString() === '\r\n') value = value.slice(0, -2);
        fields[nameMatch[1]] = value.toString('utf8');
      }
    }
    start = next;
  }
  return fields;
}

/* SendGrid's `headers` field is the raw RFC 5322 header block as one string.
   classifyMessage()/header() expect a plain {name: value} object (same shape
   ImapFlow's parsed headers take on the IMAP side), so parse it into one. */
function parseRawHeaders(raw) {
  const out = {};
  if (!raw) return out;
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

  const contentType = req.headers['content-type'] || '';
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/);
  if (!boundaryMatch) {
    log.error('sendgrid_inbound_no_boundary', { contentType });
    res.statusCode = 200; // not our SendGrid config's fault necessarily — never retry-storm on this
    return res.end();
  }
  const boundary = boundaryMatch[1] || boundaryMatch[2];

  let fields;
  try {
    const raw = await readRawBody(req);
    fields = parseMultipartFields(raw, boundary);
  } catch (e) {
    log.error('sendgrid_inbound_parse_failed', { error: String(e) });
    res.statusCode = 200;
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
