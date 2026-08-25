'use strict';

/**
 * Gmail over IMAP: reading replies, and reading back campaigns the user sent
 * before they had this tool.
 *
 * Everything here is bounded by a deadline. A hosted function is killed at
 * 60s with no chance to clean up, so each scan takes a budget, stops early
 * when it runs out, and hands back a cursor to carry on with. A partial
 * result the caller can resume beats a timeout that loses the work.
 *
 * The App Password is passed in per call and never stored: it arrives from the
 * browser, is used, and goes out of scope with the connection.
 */

const { ImapFlow } = require('imapflow');
const { classifyMessage, referencedIds, header } = require('./classify');

const GMAIL = { host: 'imap.gmail.com', port: 993, secure: true };

/* Timeouts sized for a serverless function, not a long-lived daemon: fail
   fast and report, rather than hanging until the platform kills us. */
const TIMEOUTS = { connectionTimeout: 15000, greetingTimeout: 10000, socketTimeout: 45000 };

function client(user, pass) {
  return new ImapFlow(Object.assign({}, GMAIL, TIMEOUTS, {
    auth: { user, pass: String(pass).replace(/\s+/g, '') },
    logger: false,
    emitLogs: false,
  }));
}

/** Run fn with a connected client, always logging out. */
async function withClient(user, pass, fn) {
  const c = client(user, pass);
  await c.connect();
  try {
    return await fn(c);
  } finally {
    try { await c.logout(); } catch (e) { try { c.close(); } catch (e2) {} }
  }
}

/** Verify the App Password works for IMAP (it is enabled separately from SMTP). */
async function verify(user, pass) {
  return withClient(user, pass, async c => {
    const boxes = await c.list();
    return {
      ok: true,
      mailboxes: boxes.length,
      sent: sentPath(boxes),
    };
  });
}

/* Gmail localises folder names ("Enviados", "送信済み"), so never match on the
   label — \Sent is the special-use flag every IMAP server sets. */
function sentPath(boxes) {
  const flagged = boxes.find(b => b.specialUse === '\\Sent');
  if (flagged) return flagged.path;
  const named = boxes.find(b => /^\[Gmail\]\/Sent/i.test(b.path) || /^Sent/i.test(b.path));
  return named ? named.path : 'INBOX';
}

/**
 * Find the part number of the plain-text body inside a message's
 * bodyStructure, walking multipart nodes recursively. Falls back to a
 * text/html part (stripped of tags by the caller) if there is no
 * text/plain alternative, and to part "1" for a single-part message with no
 * childNodes at all.
 *
 * This exists because the literal bodyParts key `'text'` is NOT a "give me
 * the plain-text alternative" shortcut — ImapFlow passes it straight
 * through as the wire-level `BODY[TEXT]` fetch item, which per RFC 3501
 * means the message's text *excluding only the top-level header* — for a
 * multipart/alternative message that is the ENTIRE multipart body: MIME
 * boundaries, each part's own Content-Type header, and both the plain-text
 * and HTML alternatives concatenated. Every real client (Gmail's own web
 * compose included) sends multipart/alternative, so this bug reached every
 * live reply and every live import, not an edge case: lib/classify.js's
 * body-pattern matching (out-of-office / unsubscribe detection) was
 * comparing regexes against a blob that started with
 * "Content-Type: text/plain; charset=..." rather than the actual reply
 * text, degrading (not breaking outright, since the boundary junk is
 * usually short relative to a real reply) how reliably those patterns fire.
 */
function plainTextPart(structure) {
  if (!structure) return null;
  if (!structure.childNodes) return structure.type === 'text/html' ? { part: null, html: true } : { part: '1' };

  const plain = findPart(structure, 'text/plain');
  if (plain) return { part: plain.part };
  const html = findPart(structure, 'text/html');
  if (html) return { part: html.part, html: true };
  return null;
}
function findPart(node, type) {
  if (!node) return null;
  if (node.type === type) return node;
  for (const child of node.childNodes || []) {
    const found = findPart(child, type);
    if (found) return found;
  }
  return null;
}

/** Strip tags crudely for the text/html fallback — good enough for
    classification and template diffing, not meant to be a real renderer. */
const stripTagsRough = html => String(html || '')
  .replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '')
  .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n')
  .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();

/**
 * Read the correct part out of bodyParts, keyed by whichever part number
 * plainTextPart() resolved to (msg must have been fetched with that part
 * requested — see textFetchOptions()).
 */
const textOf = (msg, partInfo) => {
  const parts = msg.bodyParts;
  if (!parts || !partInfo || !partInfo.part) return '';
  const buf = parts.get(partInfo.part);
  if (!buf) return '';
  const raw = buf.toString('utf8');
  return partInfo.html ? stripTagsRough(raw) : raw;
};

/**
 * Fetch the plain-text body of ONE message by UID, given its bodyStructure
 * is already known (from an earlier, batched fetch that included it — see
 * scanReplies()/fetchBodies() below). One extra targeted round trip per
 * message, for exactly the right part.
 *
 * This can't be collapsed into the original batched fetch. Asking for a
 * body part that does not exist on a given message (e.g. BODY.PEEK[1.1] on
 * a message that only has parts 1 and 2 — structures vary message to
 * message) does not just return empty for that one part — Gmail's IMAP
 * server rejects the WHOLE FETCH command with a NO response ("Some
 * messages could not be FETCHed"), so one "ask for every plausible part
 * number, for everyone" fetch across a batch of UIDs fails outright the
 * moment any single message's shape doesn't match, rather than degrading
 * gracefully. Fetching bodyStructure for the whole batch first (which is
 * always safe — no per-part risk) and then asking each message
 * individually for exactly the part IT has is the correct, if costlier,
 * shape for this.
 */
async function fetchPlainText(c, uid, structure, maxLength) {
  const partInfo = plainTextPart(structure);
  if (!partInfo || !partInfo.part) return '';
  for await (const msg of c.fetch(uid, {
    uid: true, bodyParts: [{ key: partInfo.part, maxLength }],
  }, { uid: true })) {
    return textOf(msg, partInfo);
  }
  return '';
}

const addr = a => (a && a[0] && a[0].address) ? String(a[0].address).toLowerCase() : '';

/**
 * Scan the inbox and classify everything that arrived since `since`.
 *
 * Returns raw findings; matching them to sends and updating suppression is the
 * caller's job, because that needs the database and this file deliberately
 * does not.
 */
async function scanReplies(opts) {
  const { user, pass, since, deadline, cursor } = opts;
  const stopAt = deadline || (Date.now() + 45000);
  const out = { messages: [], examined: 0, done: true, cursor: null, mailbox: 'INBOX' };

  return withClient(user, pass, async c => {
    const lock = await c.getMailboxLock('INBOX');
    try {
      let uids = await c.search({ since }, { uid: true });
      if (!uids || !uids.length) return out;

      uids.sort((a, b) => a - b);
      if (cursor) uids = uids.filter(u => u > Number(cursor));
      out.total = uids.length;

      /* Drain the batched fetch fully into an array BEFORE doing any
         follow-up per-message fetch. A single IMAP connection can only run
         one command at a time; awaiting a second c.fetch() call from
         inside this loop while THIS iterator is still "open" (mid-command,
         waiting on its next chunk) deadlocks the connection outright —
         confirmed directly: the follow-up fetch never resolves and the
         socket eventually times out. Two separate, sequential passes over
         the same connection is correct; interleaving them is not. */
      const batch = [];
      for await (const msg of c.fetch(uids, {
        uid: true, envelope: true, internalDate: true, bodyStructure: true,
        headers: ['auto-submitted', 'x-autoreply', 'x-autorespond', 'content-type',
                  'precedence', 'list-id', 'list-unsubscribe', 'in-reply-to',
                  'references', 'x-failed-recipients', 'x-auto-response-suppress'],
      }, { uid: true })) {
        batch.push(msg);
      }

      for (const msg of batch) {
        out.examined++;

        const env = msg.envelope || {};
        const headers = parseHeaders(msg.headers);
        /* A second, per-message round trip for exactly the right part —
           see fetchPlainText()'s doc comment for why this can't be
           collapsed into the fetch above: asking for a body part that
           doesn't exist on THIS message (structures vary message to
           message) makes Gmail's IMAP server reject the whole batched
           FETCH, not just that one part. */
        const text = await fetchPlainText(c, msg.uid, msg.bodyStructure, 4096);
        const verdict = classifyMessage({
          from: addr(env.from),
          subject: env.subject || '',
          headers,
          text,
          contentType: header(headers, 'content-type'),
        });

        out.messages.push({
          uid: msg.uid,
          receivedAt: (msg.internalDate || env.date || new Date()).toISOString(),
          from: addr(env.from),
          subject: env.subject || '',
          snippet: snippet(text),
          kind: verdict.kind,
          hard: verdict.hard,
          oooUntil: verdict.oooUntil ? verdict.oooUntil.toISOString() : null,
          reason: verdict.reason,
          inReplyTo: header(headers, 'in-reply-to') || null,
          references: referencedIds({ headers }),
        });

        /* Out of budget: stop cleanly and let the caller resume from here
           rather than being killed mid-fetch. */
        if (Date.now() > stopAt) {
          out.done = false;
          out.cursor = String(msg.uid);
          break;
        }
      }
      return out;
    } finally {
      lock.release();
    }
  });
}

/* ImapFlow returns raw header bytes; turn them into a plain lookup object.
   Folded headers (a continuation line starting with whitespace) belong to the
   previous field, so they are appended rather than dropped. */
function parseHeaders(buf) {
  const h = {};
  if (!buf) return h;
  let last = null;
  for (const line of buf.toString('utf8').split(/\r?\n/)) {
    if (/^\s/.test(line) && last) { h[last] += ' ' + line.trim(); continue; }
    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (m) { last = m[1].toLowerCase(); h[last] = m[2]; }
  }
  return h;
}

function snippet(text) {
  return String(text || '')
    .replace(/^>.*$/gm, '')                 // drop quoted history
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220);
}

/* ---------- importing campaigns sent before this tool existed ---------- */

/* Strip the parts of a subject that personalisation changes, so
   "Hi Anita, our new range" and "Our new range" land in the same cluster. */
function normaliseSubject(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/^(re|fwd?)\s*:\s*/gi, '')
    .replace(/^(hi|hello|hey|dear)\s+[^,]{1,30},?\s*/i, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Read the Sent folder and group it into candidate campaigns.
 *
 * Envelopes only — no bodies. A Sent folder can hold tens of thousands of
 * messages and fetching bodies to draw a list would be both slow and pointless;
 * bodies are fetched later, for the messages actually chosen.
 *
 * `since`/`until` are a date RANGE, not just a lookback window: IMAP's
 * SINCE/BEFORE compare a message's internal date with time-of-day and
 * timezone disregarded entirely (RFC 3501) — a pure calendar-day comparison
 * on the server. BEFORE is exclusive, so "up to and including today" needs
 * `until` set to the day AFTER the intended end date, or today's own
 * messages are silently excluded; the caller is responsible for that
 * adjustment (api/import.js does it), not this function.
 *
 * `query` searches subject OR body server-side and indexed — Gmail's IMAP
 * implementation evaluates BODY/TEXT itself; this is not a fetch-then-filter
 * fallback. Combining `subject` (an exact-ish match on the merge-tag-bearing
 * subject) with `query` (a looser fragment, e.g. the invariant part of a
 * template) lets a search catch "Great meeting at the event India Health
 * 2026" and "Great meeting at the event" as the same campaign when neither
 * the exact subject nor pure timing clustering would.
 */
/**
 * Build the IMAP search object for scanSent(), split out as a pure function
 * so the mapping from our params to the wire-level SINCE/BEFORE/SUBJECT/OR
 * criteria can be unit-tested without a live IMAP connection or mocking the
 * whole ImapFlow client.
 */
function buildSentSearch(opts) {
  const { since, until, subject, query, to } = opts || {};
  const search = {};
  if (since) search.since = since;
  if (until) search.before = until;
  if (subject) search.subject = subject;
  if (to) search.to = to;
  if (query) search.or = [{ subject: query }, { body: query }];
  if (!since && !until && !subject && !to && !query) search.all = true;
  return search;
}

async function scanSent(opts) {
  const { user, pass, since, until, subject, query: bodyOrSubjectQuery, to, deadline, cursor } = opts;
  const stopAt = deadline || (Date.now() + 45000);

  return withClient(user, pass, async c => {
    const boxes = await c.list();
    const path = sentPath(boxes);
    const lock = await c.getMailboxLock(path);
    try {
      const search = buildSentSearch({ since, until, subject, query: bodyOrSubjectQuery, to });
      let uids = await c.search(search, { uid: true });
      const out = { mailbox: path, messages: [], examined: 0, done: true, cursor: null, total: 0 };
      if (!uids || !uids.length) return out;

      /* Newest first: a user importing past work is nearly always after
         something recent, and the budget may not cover the whole folder. */
      uids.sort((a, b) => b - a);
      if (cursor) uids = uids.filter(u => u < Number(cursor));
      out.total = uids.length;

      for await (const msg of c.fetch(uids, {
        uid: true, envelope: true, internalDate: true,
        /* Needed to link an imported message to whichever OTHER imported
           message it replies to, so a follow-up sent after import threads
           onto the latest point in the conversation rather than always the
           very first message. scanReplies() already fetches these same two
           headers for the inbox side; this is the Sent-folder equivalent. */
        headers: ['in-reply-to', 'references'],
      }, { uid: true })) {
        out.examined++;
        const env = msg.envelope || {};
        const recipients = (env.to || []).map(x => String(x.address || '').toLowerCase()).filter(Boolean);
        const headers = parseHeaders(msg.headers);
        out.messages.push({
          uid: msg.uid,
          messageId: env.messageId || null,
          at: (msg.internalDate || env.date || new Date()).toISOString(),
          subject: env.subject || '',
          normalised: normaliseSubject(env.subject),
          to: recipients,
          bccLikely: recipients.length === 0,
          inReplyTo: header(headers, 'in-reply-to') || null,
          references: referencedIds({ headers }),
        });
        if (Date.now() > stopAt) {
          out.done = false;
          out.cursor = String(msg.uid);
          break;
        }
      }
      return out;
    } finally {
      lock.release();
    }
  });
}

/** Fetch full bodies for a chosen set of UIDs, so a template can be rebuilt. */
async function fetchBodies(opts) {
  const { user, pass, mailbox, uids } = opts;
  if (!uids || !uids.length) return [];
  return withClient(user, pass, async c => {
    const lock = await c.getMailboxLock(mailbox || 'INBOX');
    try {
      const out = [];
      // bodyStructure only, first — asking for a specific body part number
      // here would be unsafe (see fetchPlainText()'s doc comment): message
      // shapes in the same batch can differ, and one wrong part number
      // makes Gmail's IMAP server reject the ENTIRE fetch, not just that
      // one message. fetchBodies() is only ever called with a handful of
      // UIDs (api/import.js caps preview() at 12), so the extra per-message
      // round trip this costs is cheap.
      //
      // Fully drained into an array before any follow-up fetch — see the
      // identical note in scanReplies() above: awaiting a second c.fetch()
      // while this async iterator is still open deadlocks the connection,
      // confirmed directly (the socket eventually times out rather than the
      // follow-up fetch ever resolving).
      const batch = [];
      for await (const msg of c.fetch(uids, {
        uid: true, envelope: true, internalDate: true, bodyStructure: true,
        // Needed by lib/importer.js's linkThreadPositions() to tell which
        // of these messages is itself a reply to another one in the same
        // import — the same headers scanSent() already fetches for the
        // envelope-only pass; fetchBodies() needs its own copy since
        // commit() re-fetches full messages by UID independently of scan().
        headers: ['in-reply-to', 'references'],
      }, { uid: true })) {
        batch.push(msg);
      }

      for (const msg of batch) {
        const env = msg.envelope || {};
        const body = await fetchPlainText(c, msg.uid, msg.bodyStructure, 65536);
        const headers = parseHeaders(msg.headers);
        out.push({
          uid: msg.uid,
          messageId: env.messageId || null,
          subject: env.subject || '',
          at: (msg.internalDate || env.date || new Date()).toISOString(),
          to: (env.to || []).map(x => String(x.address || '').toLowerCase()).filter(Boolean),
          body,
          attachments: attachmentNames(msg.bodyStructure),
          inReplyTo: header(headers, 'in-reply-to') || null,
          references: referencedIds({ headers }),
        });
      }
      return out;
    } finally {
      lock.release();
    }
  });
}

function attachmentNames(node, acc) {
  const out = acc || [];
  if (!node) return out;
  const disp = String(node.disposition || '').toLowerCase();
  const name = (node.dispositionParameters && node.dispositionParameters.filename)
    || (node.parameters && node.parameters.name);
  if (disp === 'attachment' && name) out.push(name);
  (node.childNodes || []).forEach(child => attachmentNames(child, out));
  return out;
}

module.exports = {
  verify, scanReplies, scanSent, fetchBodies,
  normaliseSubject, sentPath, parseHeaders, snippet, buildSentSearch,
  plainTextPart, textOf, fetchPlainText,
};
