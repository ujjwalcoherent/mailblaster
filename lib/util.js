'use strict';

/** Read + parse a JSON body. Vercel pre-parses; local dev server does not. */
async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch (e) { return {}; }
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return {}; }
}

function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

/* ---------- salutation parsing (shared by API + client) ---------- */

const GENERIC = new Set(['info', 'admin', 'hr', 'contact', 'sales', 'support', 'team', 'office',
  'careers', 'career', 'hello', 'hi', 'mail', 'email', 'enquiry', 'enquiries', 'inquiry', 'help',
  'service', 'services', 'accounts', 'account', 'billing', 'noreply', 'no-reply', 'marketing',
  'general', 'desk', 'reception', 'md', 'ceo', 'the', 'and']);

function titleCase(s) {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function parseName(email) {
  const local = String(email).split('@')[0] || '';
  let tokens = local.replace(/[0-9]+/g, ' ').split(/[._\-+\s]+/).filter(Boolean);
  tokens = tokens.flatMap(t => t.replace(/([a-z])([A-Z])/g, '$1 $2').split(' ')).filter(Boolean);
  const named = tokens.filter(t => !GENERIC.has(t.toLowerCase()) && t.length > 1);
  if (!named.length) return { first: '', full: '', generic: true };
  const parts = named.slice(0, 2).map(titleCase);
  return { first: parts[0], full: parts.join(' '), generic: false };
}

function render(tpl, r, fallback) {
  const first = r.first || fallback;
  const full = r.full || fallback;
  return String(tpl || '')
    .replace(/\{\{\s*name\s*\}\}/gi, first)
    .replace(/\{\{\s*first_?name\s*\}\}/gi, first)
    .replace(/\{\{\s*full_?name\s*\}\}/gi, full)
    .replace(/\{\{\s*email\s*\}\}/gi, r.email || '');
}

function stripHtml(html) {
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .trim();
}

/**
 * Build the Gmail transport.
 *
 * 465 is implicit SSL and 587 is STARTTLS — Gmail accepts both. Plenty of
 * corporate networks and ISPs block 465 outbound while leaving 587 open, so
 * the port is a UI choice rather than a hardcoded constant.
 */
function gmailTransport(nodemailer, user, pass, port) {
  const p = Number(port) === 587 ? 587 : 465;
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: p,
    secure: p === 465,
    requireTLS: p === 587,
    auth: { user, pass: String(pass).replace(/\s+/g, '') },
    connectionTimeout: 20000,
    greetingTimeout: 20000,
  });
}

module.exports = { readJson, send, parseName, render, stripHtml, gmailTransport };
