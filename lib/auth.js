'use strict';

/**
 * API key check.
 *
 * The endpoints read and delete campaign history, so on a public URL they need
 * a gate. This is deliberately the simplest thing that works for a single-user
 * tool: one shared secret in an environment variable.
 *
 * What it is NOT: a multi-tenant auth system. There is one key for the whole
 * deployment, so anyone holding it can see everything. Per-user API keys would
 * need the key stored against an owner and every query scoped to that owner —
 * campaigns are currently scoped by Gmail address, which is a convenience, not
 * a security boundary.
 *
 * When MAILBLASTER_API_KEY is unset the check is skipped, so local development
 * needs no setup. That is safe locally and unsafe on a public host, which is
 * why /api/log reports whether the deployment is protected.
 */

const crypto = require('crypto');

const KEY = () => process.env.MAILBLASTER_API_KEY || '';

/** Is a key configured at all? */
const enabled = () => !!KEY();

/**
 * Compare in constant time.
 *
 * A plain === leaks the position of the first wrong character through timing,
 * which is enough to recover a secret one byte at a time. Lengths are hashed
 * first so the comparison is always over equal-length buffers.
 */
function matches(given) {
  const expected = KEY();
  if (!expected) return true;
  if (!given) return false;
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Pull the key from wherever the caller put it.
 *
 * Header first — a query string ends up in server logs, browser history and
 * referrer headers — but ?key= is accepted because it makes a quick curl or a
 * webhook possible.
 */
function present(req) {
  const h = req.headers || {};
  const auth = h.authorization || h.Authorization || '';
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  if (h['x-api-key']) return String(h['x-api-key']).trim();
  const q = req.query || {};
  if (q.key) return String(q.key).trim();
  return null;
}

/**
 * Guard a handler. Returns 401 with a code from the shared error table, so an
 * authentication failure looks like every other failure to a client.
 */
function require_(handler) {
  return async function (req, res) {
    if (enabled() && !matches(present(req))) {
      const { send } = require('./util');
      const log = require('./log');
      log.warn('unauthorized', {
        api: req.url, method: req.method,
        /* Log that a key was offered, never the key itself. */
        presented: !!present(req),
      });
      return send(res, 401, {
        ok: false,
        code: 'UNAUTHORIZED',
        error: 'A valid API key is required.',
        hint: 'Send it as "Authorization: Bearer <key>" or the "X-API-Key" header.',
        retry: 'never',
      });
    }
    return handler(req, res);
  };
}

module.exports = { enabled, matches, present, require: require_ };
