'use strict';
/**
 * Structured request logging.
 *
 * One JSON line per request, so hosted logs can be filtered and counted rather
 * than read by eye. Credentials and message bodies are never logged: an email
 * address is identifying enough to debug with, and an App Password in a log is
 * a credential leak that outlives the request.
 */

const REDACT = /(pass|password|token|secret|authorization)/i;

/** Strip anything sensitive before a value reaches the log. */
function safe(obj, depth) {
  const d = depth || 0;
  if (obj == null || d > 3) return obj;
  if (Array.isArray(obj)) return obj.length > 20 ? '[' + obj.length + ' items]' : obj.map(o => safe(o, d + 1));
  if (typeof obj !== 'object') {
    return typeof obj === 'string' && obj.length > 200 ? obj.slice(0, 200) + '…' : obj;
  }
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (REDACT.test(k)) { out[k] = '[redacted]'; continue; }
    if (k === 'body' || k === 'bodyHtml' || k === 'content') { out[k] = '[' + String(v || '').length + ' chars]'; continue; }
    out[k] = safe(v, d + 1);
  }
  return out;
}

function emit(level, event, data) {
  const line = Object.assign({
    t: new Date().toISOString(),
    level,
    event,
  }, safe(data || {}));
  const text = JSON.stringify(line);
  if (level === 'error') console.error(text); else console.log(text);
}

const info = (event, data) => emit('info', event, data);
const warn = (event, data) => emit('warn', event, data);
const error = (event, data) => emit('error', event, data);

/**
 * Wrap a handler so every request is logged once with its outcome and
 * duration, and an unhandled throw becomes a structured error response
 * instead of a platform stack trace.
 */
function wrap(name, handler) {
  return async function (req, res) {
    const started = Date.now();
    const { send } = require('./util');
    const { describe, httpFor, classify } = require('./errors');
    let status = 200;
    const realEnd = res.end.bind(res);
    res.end = function (...args) { status = res.statusCode; return realEnd(...args); };

    try {
      await handler(req, res);
      const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
      emit(level, 'request', { api: name, method: req.method, status, ms: Date.now() - started });
    } catch (e) {
      const code = classify(e);
      error('unhandled', {
        api: name, method: req.method, code,
        message: e && e.message, ms: Date.now() - started,
        stack: e && e.stack ? String(e.stack).split('\n').slice(0, 3).join(' | ') : null,
      });
      if (!res.writableEnded) send(res, httpFor(code), describe(e));
    }
  };
}

module.exports = { info, warn, error, wrap, safe };
