'use strict';
/**
 * Two ways replies get into the system, in one file rather than two separate
 * serverless functions — Vercel's Hobby plan caps a deployment at 12
 * functions, and this repo was already sitting at exactly that limit before
 * SendGrid entered the picture, so a 13th function is a real deploy-breaker,
 * not just a style preference. See git history (two failed deployments) for
 * why this isn't a new file.
 *
 * 1. POST /api/replies   { user, pass, days, cursor }
 *    Scan a Gmail inbox for replies, out-of-office notices and bounces, match
 *    them back to the sends they answer, and update suppression. Resumable
 *    by design — a hosted function is killed at 60s with no chance to clean
 *    up, so the scan takes a budget, stops early, and returns a cursor to
 *    carry on with. The App Password is used for this request and never
 *    stored. Requires our own API key (auth.require).
 *
 * 2. POST /api/replies?source=sendgrid&key=<SENDGRID_INBOUND_SECRET>
 *    SendGrid's Inbound Parse webhook — a reply landing on
 *    reply.coherentconnect.ai gets POSTed here as multipart/form-data the
 *    instant it arrives. Feeds the exact same recordReply/classifyMessage
 *    path as the IMAP scan above, so a SendGrid-routed reply suppresses
 *    future follow-ups identically to an IMAP-detected one. SendGrid cannot
 *    send our normal auth header, so this path is protected by a shared
 *    secret in the URL instead of auth.require, and is dispatched to BEFORE
 *    auth.require ever runs.
 */
const { readJson, send } = require('../lib/util');
const store = require('../lib/store');
const imap = require('../lib/imap');
const { classifyMessage } = require('../lib/classify');
const { describe, httpFor, classify } = require('../lib/errors');
const log = require('../lib/log');
const auth = require('../lib/auth');

/* Leave headroom under the 60s function limit so the response still gets out. */
const BUDGET_MS = 40000;

async function handleImapScan(req, res) {
  if (req.method !== 'POST') return send(res, 405, describe('METHOD_NOT_ALLOWED'));

  const b = await readJson(req);
  if (!b.user || !b.pass) return send(res, 400, describe('AUTH_REQUIRED'));

  const days = Math.min(Math.max(Number(b.days) || 30, 1), 365);
  const since = new Date(Date.now() - days * 86400000);

  let scan;
  try {
    scan = await imap.scanReplies({
      user: b.user,
      pass: b.pass,
      since,
      cursor: b.cursor || null,
      deadline: Date.now() + BUDGET_MS,
    });
  } catch (e) {
    const code = classify(e);
    log.warn('imap_scan_failed', { code, message: e.message });
    return send(res, httpFor(code), describe(e));
  }

  /* Nothing is stored when there is no database: the classification is still
     returned so the browser can show it, but suppression cannot be durable. */
  const available = await store.available();
  const summary = { reply: 0, ooo: 0, bounce: 0, unsubscribe: 0, auto: 0 };
  const recorded = [];

  for (const m of scan.messages) {
    summary[m.kind] = (summary[m.kind] || 0) + 1;
    if (!available) { recorded.push(m); continue; }
    try {
      const saved = await store.recordReply(m);
      recorded.push(Object.assign({}, m, saved));
    } catch (e) {
      log.error('reply_persist_failed', { code: classify(e), message: e.message, uid: m.uid });
      recorded.push(m);
    }
  }

  log.info('reply_scan', {
    examined: scan.examined, matched: recorded.filter(r => r.matched).length,
    done: scan.done, days, summary,
  });

  send(res, 200, {
    ok: true,
    available,
    examined: scan.examined,
    total: scan.total || scan.examined,
    done: scan.done,
    cursor: scan.cursor,
    summary,
    messages: recorded,
  });
}

/* ---- SendGrid Inbound Parse: no multipart library, on purpose ----
   This repo is deliberately dependency-light (no framework, no build step
   per README/CLAUDE.md), and SendGrid's Parse payload is a small, fixed set
   of plain-text fields (from, to, subject, text, html, headers, envelope,
   spam_score) — attachments are the only binary parts, and this endpoint
   doesn't need them, so a ~40-line parser scoped to this one known shape is
   less risk than a general multipart-parsing dependency (one already broke
   two deployments outright — see git history). */

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

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
        if (value.slice(-2).toString() === '\r\n') value = value.slice(0, -2);
        fields[nameMatch[1]] = value.toString('utf8');
      }
    }
    start = next;
  }
  return fields;
}

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

async function handleSendGridInbound(req, res) {
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
    res.statusCode = 200;
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
}

module.exports = log.wrap('replies', async function handler(req, res) {
  if ((req.query || {}).source === 'sendgrid') {
    return handleSendGridInbound(req, res);
  }
  return auth.require(handleImapScan)(req, res);
});
