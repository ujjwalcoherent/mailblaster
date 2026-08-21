'use strict';

/**
 * Decide what an incoming message actually is.
 *
 * Order matters, and it is not the obvious one. An out-of-office IS a reply in
 * every mechanical sense — it arrives in the thread, it carries In-Reply-To —
 * and a bounce usually carries In-Reply-To too. So the checks run
 * bounce -> auto/OOO -> unsubscribe -> human, and the first match wins.
 * Reversing that order makes every auto-responder look like engagement.
 */

const DAEMON = /^(mailer-daemon|postmaster|no-?reply|nobody|bounce|bounces|maildaemon)@/i;

const OOO_SUBJECT = new RegExp([
  'out of (the )?office', 'ooo\\b', 'auto(matic)?[ -]?reply', 'autoreply', 'auto-?responder',
  'on leave', 'annual leave', 'maternity leave', 'paternity leave', 'sick leave',
  'away from (my |the )?(desk|office|email)', 'currently (away|unavailable|travel)',
  'i am (currently )?(away|out|on holiday|on vacation)', 'vacation', 'holiday notice',
  'no longer with', 'has left the company', 'left the organisation', 'left the organization',
  'thank you for your (email|message).*(away|out of office)',
].join('|'), 'i');

const UNSUB_SUBJECT = /\b(unsubscribe|remove me from|opt[- ]?out|stop (sending|emailing))\b/i;

/* Matching the BODY is far riskier than matching the subject. A human reply
   that merely mentions being away — "I was out of office last week, sorry for
   the delay, very interested!" — must not be filed as a vacation responder, or
   a live prospect silently drops out of every follow-up.

   So these patterns demand a first-person, present-tense statement near the
   start of the message: how a real auto-responder opens, and how someone
   discussing their diary in passing does not. */
const OOO_BODY = new RegExp([
  "^[^.!?\\n]{0,60}\\bi (?:am|will be|shall be) (?:currently |presently )?"
    + "(?:out of (?:the )?office|away|on (?:annual |sick |maternity |paternity )?leave"
    + "|on (?:holiday|vacation)|unavailable|not available)",
  /* The classic corporate responder opens with a thank-you SENTENCE and then
     states the absence in the next one, so this one pattern deliberately
     crosses a sentence boundary — but only within a short window, and only
     when both halves are present. */
  "\\bthank you for your (?:email|message)\\b[\\s\\S]{0,100}?\\b(?:i am|i'm) (?:currently )?"
    + "(?:away|out of (?:the )?office|on leave|unavailable|not in the office)",
  "\\b(?:this|the following) is an (?:automatic|automated) (?:reply|response|message)",
  "\\bi (?:will|shall) (?:reply|respond|get back to you) (?:when i return|on my return|upon my return)",
  "\\bi (?:am|'m) (?:currently )?(?:travelling|traveling) (?:and|with) (?:limited|no) (?:access|email)",
].join('|'), 'i');

/* Same reasoning for opt-out. "Remove me from your list" is a request;
   "please remove me from the CC on that thread" is ordinary conversation. */
const UNSUB_BODY = new RegExp(
  "\\b(?:please\\s+)?(?:unsubscribe me"
  + "|remove me from (?:your|the|this|all|any)\\s+(?:list|mailing|database|records|future|email)"
  + "|take me off (?:your|the) (?:list|mailing)"
  + "|opt[- ]?out of|stop (?:sending|emailing) me)\\b", 'i');

/* Permanent failures. Anything else that looks like a bounce is treated as
   soft, because guessing "permanent" wrongly loses a real contact forever. */
const HARD_BOUNCE = new RegExp([
  'user unknown', 'no such user', 'unknown user', 'does not exist', "doesn't exist",
  'no such (mailbox|address|recipient)', 'recipient (address )?rejected',
  'address not found', 'invalid recipient', 'unrouteable address', 'unrouteable',
  'account (has been )?(disabled|closed|terminated)', 'mailbox unavailable',
  'domain not found', 'host or domain name not found', '550 5\\.1\\.1', '550 5\\.1\\.10',
].join('|'), 'i');

const SOFT_BOUNCE = new RegExp([
  'mailbox full', 'over quota', 'quota exceeded', 'insufficient storage',
  'temporarily (unavailable|deferred|rejected)', 'try again later', 'greylist',
  'connection timed out', 'too many messages', 'rate limit', '452 4\\.2\\.2', '4\\.7\\.',
].join('|'), 'i');

/** Return the first header value, case-insensitively. */
function header(headers, name) {
  if (!headers) return '';
  const key = name.toLowerCase();
  if (typeof headers.get === 'function') {          // Map, as ImapFlow returns
    const v = headers.get(key);
    return Array.isArray(v) ? String(v[0] || '') : String(v || '');
  }
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === key) {
      const v = headers[k];
      return Array.isArray(v) ? String(v[0] || '') : String(v || '');
    }
  }
  return '';
}

/**
 * Pull the date an out-of-office says the person returns, so they can be
 * retried afterwards instead of being suppressed for good.
 * Understands "until 5 March", "back on 2026-03-05", "returning 5/3/2026".
 */
function untilDate(text, now) {
  const t = String(text || '').slice(0, 2000);
  const base = now || new Date();

  const iso = t.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) return new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3]));

  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const named = t.match(/\b(?:until|till|through|back on|return(?:ing)? on|returns? on|after)\s+(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\b/i)
             || t.match(/\b(?:until|till|through|back on|return(?:ing)? on|returns? on|after)\s+([a-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?\b/i);
  if (named) {
    const a = named[1], b = named[2];
    const monthFirst = isNaN(Number(a));
    const mi = MONTHS.indexOf(String(monthFirst ? a : b).slice(0, 3).toLowerCase());
    const day = Number(monthFirst ? b : a);
    if (mi >= 0 && day >= 1 && day <= 31) {
      let year = base.getUTCFullYear();
      const d = new Date(Date.UTC(year, mi, day));
      if (d < base) d.setUTCFullYear(year + 1);      // a past date means next year
      return d;
    }
  }

  const numeric = t.match(/\b(?:until|till|back on|return(?:ing)? on)\s+(\d{1,2})[\/.](\d{1,2})(?:[\/.](\d{2,4}))?/i);
  if (numeric) {
    const day = +numeric[1], mon = +numeric[2];
    let year = numeric[3] ? +numeric[3] : base.getUTCFullYear();
    if (year < 100) year += 2000;
    if (mon >= 1 && mon <= 12 && day >= 1 && day <= 31) {
      const d = new Date(Date.UTC(year, mon - 1, day));
      if (d < base) d.setUTCFullYear(d.getUTCFullYear() + 1);
      return d;
    }
  }
  return null;
}

/**
 * Classify one message.
 *
 * @param {object} m  { from, subject, headers, text, contentType }
 * @returns {object}  { kind, hard, oooUntil, reason }
 *                    kind: bounce | ooo | unsubscribe | auto | reply
 */
function classifyMessage(m, now) {
  const from = String(m.from || '').toLowerCase();
  const subject = String(m.subject || '');
  const text = String(m.text || '');
  const h = m.headers;
  const blob = subject + '\n' + text;

  const autoSubmitted = header(h, 'auto-submitted').toLowerCase();
  const contentType = (m.contentType || header(h, 'content-type')).toLowerCase();
  const precedence = header(h, 'precedence').toLowerCase();

  /* 1. Bounces first: a delivery report also carries In-Reply-To, so checking
        for a reply before this would classify every bounce as engagement. */
  const isReport = contentType.includes('multipart/report')
    || contentType.includes('delivery-status')
    || /report-type=delivery-status/i.test(contentType);
  if (DAEMON.test(from) || isReport || header(h, 'x-failed-recipients')) {
    const hard = HARD_BOUNCE.test(blob) || (!SOFT_BOUNCE.test(blob) && /5\.\d\.\d/.test(blob));
    return {
      kind: 'bounce', hard, oooUntil: null,
      reason: hard ? 'permanent delivery failure' : 'temporary delivery failure',
    };
  }

  /* 2. Vacation responders. Gmail sets Auto-Submitted; most others set one of
        the X-Auto* headers. Subject matching is the last resort. */
  const autoHeader = autoSubmitted && autoSubmitted !== 'no';
  const xAuto = header(h, 'x-autoreply') || header(h, 'x-autorespond')
    || header(h, 'x-auto-response-suppress') || header(h, 'x-vacation-message');
  if (autoHeader || xAuto || OOO_SUBJECT.test(subject) || OOO_BODY.test(text.slice(0, 600))) {
    return {
      kind: 'ooo', hard: false,
      oooUntil: untilDate(blob, now),
      reason: autoHeader ? 'Auto-Submitted header'
        : xAuto ? 'X-Auto* header'
        : OOO_SUBJECT.test(subject) ? 'subject match' : 'first-person body match',
    };
  }

  /* 3. Explicit opt-out. */
  if (UNSUB_SUBJECT.test(subject) || UNSUB_BODY.test(text.slice(0, 600))) {
    return { kind: 'unsubscribe', hard: true, oooUntil: null, reason: 'opt-out request' };
  }

  /* 4. Bulk mail that is neither a bounce nor a vacation note — newsletters
        that happened to land in the same mailbox. Not engagement. */
  if (precedence === 'bulk' || precedence === 'list' || header(h, 'list-id')) {
    return { kind: 'auto', hard: false, oooUntil: null, reason: 'bulk/list mail' };
  }

  /* 5. Anything left that threads onto one of our sends is a human reply. */
  return { kind: 'reply', hard: false, oooUntil: null, reason: 'threaded human reply' };
}

/**
 * Match an incoming message back to a send.
 *
 * In-Reply-To and References are authoritative: they survive forwarding and
 * address aliases, which a From match does not. The caller falls back to
 * matching on address only when neither header resolves.
 */
function referencedIds(m) {
  const ids = [];
  const irt = header(m.headers, 'in-reply-to') || m.inReplyTo || '';
  const refs = header(m.headers, 'references') || m.references || '';
  for (const chunk of [irt, refs]) {
    const found = String(chunk).match(/<[^>]+>/g);
    if (found) ids.push(...found);
  }
  return [...new Set(ids)];
}

module.exports = { classifyMessage, referencedIds, untilDate, header };
