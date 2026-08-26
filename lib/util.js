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

/* The built-in merge fields, and only these, need aliasing: `name` and
   `first_name` are the same thing, as are `full_name`/`fullname`, and each
   falls back to the fallback greeting rather than rendering empty. Anything
   NOT in here resolves straight from the recipient row's own keys, so a CSV
   column called `website_name` makes {{website_name}} work with no code
   change — that extensibility is the point. Keys are matched
   case-insensitively and ignore _ vs nothing, so {{Website_Name}},
   {{websitename}} and {{website_name}} all hit the same column. */
const BUILTIN_FIELDS = {
  name: (r, fb) => r.first || fb,
  firstname: (r, fb) => r.first || fb,
  fullname: (r, fb) => r.full || fb,
  email: r => r.email || '',
};

const normaliseFieldKey = k => String(k || '').toLowerCase().replace(/[\s_-]+/g, '');

/**
 * Resolve one {{token}} against a recipient.
 *
 * Returns null (not '') when the token matches nothing at all, so the caller
 * can choose between leaving an unknown tag visible — which is what a person
 * proof-reading a draft needs to SEE they mistyped {{compnay}} — and blanking
 * it. Silently emptying an unknown tag is how a mail merge ships "Dear ,".
 */
function resolveField(token, r, fallback) {
  const key = normaliseFieldKey(token);
  if (BUILTIN_FIELDS[key]) return BUILTIN_FIELDS[key](r, fallback);
  // Arbitrary per-recipient data (extra CSV columns) lives on r.fields.
  const extra = r.fields || {};
  for (const k of Object.keys(extra)) {
    if (normaliseFieldKey(k) === key) {
      const v = extra[k];
      return v == null ? '' : String(v);
    }
  }
  // Also allow top-level keys, so { company: 'Acme' } works without nesting.
  for (const k of Object.keys(r)) {
    if (k === 'fields') continue;
    if (normaliseFieldKey(k) === key) {
      const v = r[k];
      return (v == null || typeof v === 'object') ? '' : String(v);
    }
  }
  return null;
}

/** Every distinct {{token}} in a template, in first-appearance order. */
function fieldsUsed(tpl) {
  const out = [];
  const seen = new Set();
  String(tpl || '').replace(/\{\{\s*([\w .-]+?)\s*\}\}/g, (_, tok) => {
    const k = normaliseFieldKey(tok);
    if (!seen.has(k)) { seen.add(k); out.push(tok.trim()); }
    return '';
  });
  return out;
}

/**
 * Fill a template against one recipient.
 *
 * One generic pass over any {{token}}, rather than one hardcoded regex per
 * supported field — adding a merge field is now a data question (does the
 * recipient carry that column?), never a code change.
 */
function render(tpl, r, fallback) {
  return String(tpl || '').replace(/\{\{\s*([\w .-]+?)\s*\}\}/g, (whole, token) => {
    const v = resolveField(token, r || {}, fallback);
    return v === null ? whole : v;   // unknown tag stays visible rather than vanishing
  });
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

module.exports = { readJson, send, parseName, render, stripHtml, gmailTransport,
  resolveField, fieldsUsed, normaliseFieldKey, BUILTIN_FIELDS };
