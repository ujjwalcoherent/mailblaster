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
  'general', 'desk', 'reception', 'md', 'ceo', 'the', 'and',
  'research', 'purchase', 'procurement', 'export', 'exports', 'import', 'imports', 'qa', 'qc',
  'rnd', 'lab', 'labs', 'factory', 'works', 'plant', 'store', 'stores', 'legal', 'finance',
  'website', 'web', 'webmaster', 'operations', 'orders', 'order', 'query', 'queries',
  'customercare', 'feedback', 'newsletter', 'subscribe', 'unsubscribe']);

/* Honorifics and professional prefixes. Left in place they become the
   greeting itself - "Hi Dr," - so they are stripped, and what remains is
   treated as a surname rather than a first name. */
const TITLES = new Set(['dr', 'mr', 'mrs', 'ms', 'miss', 'prof', 'capt', 'adv', 'ca', 'cs',
  'er', 'shri', 'smt', 'sri', 'late']);

/* Fragments that mark a mailbox as a company rather than a person. */
const COMPANYISH = /(chem|pharma|biotech|agro|tech|studio|mktg|marketing|exports?|industr|solutions?|systems?|enterprises?|traders?|group|intl|international|medipro|polymer|labs?)$/i;

function titleCase(s) {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/**
 * Pull a salutation out of the local part of an address.
 *
 * Returns a confidence alongside the name. `low` does NOT mean the name is
 * wrong - "harvinder@" and "sreesanth@" are perfectly good first names - it
 * means there is no separator to confirm where a first name ends, so the guess
 * deserves a human glance before it reaches a real inbox. The UI flags these
 * rather than silently rewriting them.
 */
function parseName(email) {
  const local = String(email).split('@')[0] || '';
  const stripped = local.replace(/[0-9]+/g, '');
  const hasSeparator = /[._\-+]/.test(stripped) || /[a-z][A-Z]/.test(local);

  let tokens = local.replace(/[0-9]+/g, ' ').split(/[._\-+\s]+/).filter(Boolean);
  tokens = tokens.flatMap(t => t.replace(/([a-z])([A-Z])/g, '$1 $2').split(' ')).filter(Boolean);
  if (!tokens.length) return { first: '', full: '', generic: true, confidence: 'none' };

  // A mailbox that OPENS with a role word is a role mailbox, whatever follows:
  // info.olivepharma@ is the company's inbox, not a person called Olivepharma.
  if (GENERIC.has(tokens[0].toLowerCase())) {
    return { first: '', full: '', generic: true, confidence: 'none' };
  }

  // Strip honorifics; note that we did, because "dr.tamhane" leaves a surname.
  const titleStripped = tokens.some(t => TITLES.has(t.toLowerCase()));
  tokens = tokens.filter(t => !TITLES.has(t.toLowerCase()));

  // "s.gadnis" is an initial plus a surname - there is no first name here.
  const initialLed = tokens.length > 1 && tokens[0].length === 1;

  const named = tokens.filter(t => !GENERIC.has(t.toLowerCase()) && t.length > 1);
  if (!named.length) return { first: '', full: '', generic: true, confidence: 'none' };

  const parts = named.slice(0, 2).map(titleCase);
  const first = parts[0];

  let confidence = 'high';
  // No vowel at all means initials, not a name: "svtk", "jgk", "crs".
  if (!/[aeiou]/i.test(first)) confidence = 'low';
  else if (titleStripped || initialLed) confidence = 'low';
  // A digit sitting between letters is not a real separator: zoom2animus is
  // one handle, not "Zoom" the person.
  const digitSplit = /[a-z][0-9]+[a-z]/i.test(local);
  // A title glued to the name reads badly as a greeting: "Hi Drdjha,".
  const titlePrefix = /^(dr|mr|mrs|ms|prof|capt)[a-z]/i.test(first) && first.length > 3;

  if (titlePrefix || digitSplit) {
    confidence = 'low';
  } else if (!hasSeparator) {
    if (COMPANYISH.test(first)) confidence = 'low';       // looks like a company
    else if (first.length >= 8) confidence = 'low';        // probably first+last run together
    else if (first.length <= 3) confidence = 'low';        // initials
  }

  return { first, full: parts.join(' '), generic: false, confidence };
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
  const p = Number(port) === 465 ? 465 : 587;   // 587 default: 465 is blocked on many networks
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
