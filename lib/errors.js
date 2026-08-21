'use strict';

/**
 * Every failure this application can produce, in one table.
 *
 * The point is the `retry` field. A send that failed because Gmail was busy
 * should be retried; a send that failed because the password is wrong must
 * not be, because Google locks the account after repeated bad auth. And a
 * send that TIMED OUT is the dangerous case: Gmail may have accepted the
 * message before the connection dropped, so a blind retry sends it twice.
 * Those are marked 'confirm' — the UI asks rather than deciding.
 *
 *   retry: 'auto'    — transient, safe to retry automatically with backoff
 *   retry: 'confirm' — may have already succeeded; ask before retrying
 *   retry: 'never'   — retrying cannot help and may make things worse
 */

const CODES = {
  /* ---- configuration / database ---- */
  DB_UNAVAILABLE: {
    retry: 'never', http: 503,
    message: 'No database configured. History is kept in this browser only.',
    hint: 'Set DATABASE_URL in your Vercel project settings.',
  },
  DB_COLD_START: {
    retry: 'auto', http: 503,
    message: 'Database is waking up.',
    hint: 'Neon suspends free compute after 5 minutes idle; the first query takes 1-2s.',
  },
  DB_CONNECTION: {
    retry: 'auto', http: 503,
    message: 'Could not reach the database.',
    hint: 'Transient network fault. Retried automatically.',
  },
  DB_QUOTA: {
    retry: 'never', http: 507,
    message: 'Database storage or compute quota exhausted.',
    hint: 'Neon free tier: 0.5 GB storage, 100 CU-hours/month. Data is never deleted.',
  },

  /* ---- credentials ---- */
  AUTH_REQUIRED: {
    retry: 'never', http: 400,
    message: 'Gmail address and app password are required.',
    hint: 'Fill in Section 1.',
  },
  AUTH_REJECTED: {
    retry: 'never', http: 401,
    message: 'Gmail rejected these credentials.',
    hint: 'Use a 16-character App Password, not your account password. '
        + 'Requires 2-Step Verification enabled.',
  },
  AUTH_APP_PASSWORD_REQUIRED: {
    retry: 'never', http: 401,
    message: 'Google requires an App Password for this account.',
    hint: 'myaccount.google.com > Security > 2-Step Verification > App passwords.',
  },

  /* ---- sending ---- */
  SEND_NO_RECIPIENT: { retry: 'never', http: 400, message: 'No recipient address.' },
  SEND_INVALID_ADDRESS: {
    retry: 'never', http: 400,
    message: 'The recipient address was rejected as malformed.',
  },
  SEND_MAILBOX_FULL: {
    retry: 'confirm', http: 200,
    message: 'Recipient mailbox is full (soft bounce).',
    hint: 'Often clears. Suppressed after 3 soft bounces.',
  },
  SEND_NO_SUCH_USER: {
    retry: 'never', http: 200,
    message: 'No such mailbox (hard bounce).',
    hint: 'Address does not exist. Marked do-not-contact.',
  },
  SEND_RATE_LIMIT: {
    retry: 'auto', http: 429,
    message: 'Gmail is rate limiting this account.',
    hint: 'Free Gmail allows ~500 recipients/day, Workspace ~2000. '
        + 'Increase the delay between sends.',
  },
  SEND_QUOTA_EXCEEDED: {
    retry: 'never', http: 429,
    message: 'Daily Gmail sending quota exhausted.',
    hint: 'Resets ~24h after the first message of the batch. Resume tomorrow.',
  },
  SEND_TIMEOUT: {
    /* The genuinely dangerous one: Gmail may have accepted the message before
       the socket dropped. Never retried silently — the UNIQUE index on
       sends(campaign_id, recipient_id) is the backstop if it is retried. */
    retry: 'confirm', http: 504,
    message: 'The connection to Gmail timed out.',
    hint: 'The message MAY have been delivered. Check before resending.',
  },
  SEND_CONNECTION: {
    retry: 'auto', http: 503,
    message: 'Could not connect to Gmail.',
    hint: 'Port 465 is blocked on many networks — try 587 in Section 1.',
  },
  SEND_ATTACHMENT_TOO_LARGE: {
    retry: 'never', http: 413,
    message: 'Attachments exceed the request size limit.',
    hint: 'Hosted functions cap the body near 4.5 MB; Gmail caps mail at 25 MB.',
  },
  SEND_DUPLICATE: {
    retry: 'never', http: 200,
    message: 'This person was already sent to in this campaign.',
    hint: 'Blocked by the database, not the browser — safe against double tabs and retries.',
  },

  /* ---- IMAP / reply detection ---- */
  IMAP_AUTH: {
    retry: 'never', http: 401,
    message: 'Gmail rejected the IMAP login.',
    hint: 'The same App Password works for IMAP, but IMAP must be enabled in Gmail settings.',
  },
  IMAP_DISABLED: {
    retry: 'never', http: 403,
    message: 'IMAP access is switched off for this Gmail account.',
    hint: 'Gmail > See all settings > Forwarding and POP/IMAP > Enable IMAP.',
  },
  IMAP_CONNECTION: { retry: 'auto', http: 503, message: 'Could not reach Gmail over IMAP.' },
  IMAP_TIMEOUT: {
    retry: 'auto', http: 504,
    message: 'The mailbox scan timed out.',
    hint: 'Hosted functions stop at 30s. Narrow the date range and scan again.',
  },

  /* ---- access ---- */
  UNAUTHORIZED: {
    retry: 'never', http: 401,
    message: 'A valid API key is required.',
    hint: 'Send it as "Authorization: Bearer <key>" or the "X-API-Key" header.',
  },

  /* ---- request ---- */
  BAD_REQUEST: { retry: 'never', http: 400, message: 'Malformed request.' },
  METHOD_NOT_ALLOWED: { retry: 'never', http: 405, message: 'Wrong HTTP method.' },
  INTERNAL: { retry: 'confirm', http: 500, message: 'Unexpected server error.' },
};

/**
 * Map a driver-level exception onto one of the codes above.
 *
 * nodemailer surfaces SMTP failures as `err.responseCode` (a real SMTP status)
 * plus `err.code` (its own socket-level name), and Postgres uses SQLSTATE in
 * `err.code`. Both are matched here, with the message text only as a fallback,
 * because message wording changes between versions but codes do not.
 */
function classify(err) {
  if (!err) return 'INTERNAL';
  const code = String(err.code || '');
  const msg = String(err.message || '').toLowerCase();
  const smtp = Number(err.responseCode || err.status || 0);

  // Socket-level, shared by SMTP and IMAP
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || msg.includes('timeout')) {
    return msg.includes('imap') ? 'IMAP_TIMEOUT' : 'SEND_TIMEOUT';
  }
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH'
      || code === 'ENOTFOUND' || code === 'ESOCKET') {
    return 'SEND_CONNECTION';
  }

  // Gmail authentication
  if (code === 'EAUTH' || smtp === 535 || smtp === 534) {
    if (msg.includes('application-specific') || msg.includes('app password')) {
      return 'AUTH_APP_PASSWORD_REQUIRED';
    }
    return 'AUTH_REJECTED';
  }

  // SMTP status codes: 5xx permanent, 4xx transient
  if (smtp === 550 || smtp === 553) {
    if (msg.includes('quota') || msg.includes('over quota')) return 'SEND_MAILBOX_FULL';
    return 'SEND_NO_SUCH_USER';
  }
  if (smtp === 552) return 'SEND_MAILBOX_FULL';
  if (smtp === 554 && msg.includes('quota')) return 'SEND_QUOTA_EXCEEDED';
  if (smtp === 421 || smtp === 450 || smtp === 451 || smtp === 452) return 'SEND_RATE_LIMIT';
  if (msg.includes('daily user sending') || msg.includes('sending quota')) return 'SEND_QUOTA_EXCEEDED';
  if (msg.includes('rate limit') || msg.includes('too many')) return 'SEND_RATE_LIMIT';

  // Postgres SQLSTATE
  if (code === '23505') return 'SEND_DUPLICATE';
  if (code === '53100' || code === '53200' || code === '53300') return 'DB_QUOTA';
  if (code === '57P01' || code === '08006' || code === '08003') return 'DB_CONNECTION';
  if (msg.includes('unique constraint') && msg.includes('sends')) return 'SEND_DUPLICATE';

  // IMAP
  if (msg.includes('imap') && (msg.includes('auth') || msg.includes('login'))) return 'IMAP_AUTH';
  if (msg.includes('imap not enabled') || msg.includes('imap access')) return 'IMAP_DISABLED';

  if (msg.includes('payload') || msg.includes('request entity too large')) {
    return 'SEND_ATTACHMENT_TOO_LARGE';
  }
  return 'INTERNAL';
}

/** Build the JSON error shape every endpoint returns. */
function describe(codeOrErr, extra) {
  const code = typeof codeOrErr === 'string' ? codeOrErr : classify(codeOrErr);
  const spec = CODES[code] || CODES.INTERNAL;
  return Object.assign({
    ok: false,
    code,
    error: spec.message,
    hint: spec.hint || null,
    retry: spec.retry,
    detail: typeof codeOrErr === 'object' && codeOrErr ? String(codeOrErr.message || '') : null,
  }, extra || {});
}

const httpFor = code => (CODES[code] || CODES.INTERNAL).http;

/**
 * Retry with exponential backoff, but only for codes marked 'auto'.
 * Anything needing a human decision is thrown straight back to the caller.
 */
async function withRetry(fn, opts) {
  const o = opts || {};
  const tries = o.tries || 3;
  const base = o.baseMs || 300;
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn(i);
    } catch (e) {
      last = e;
      const spec = CODES[classify(e)] || CODES.INTERNAL;
      if (spec.retry !== 'auto' || i === tries - 1) throw e;
      await new Promise(r => setTimeout(r, base * Math.pow(2, i)));
    }
  }
  throw last;
}

module.exports = { CODES, classify, describe, httpFor, withRetry };
