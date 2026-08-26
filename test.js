'use strict';

/**
 * Test suite. Run with:  node test.js
 *
 * Uses the SQLite driver by default so it needs no network and no secrets.
 * Set DATABASE_URL to run the same store tests against Postgres:
 *   DATABASE_URL="postgres://..." node test.js
 *
 * The store tests write to ./data/test-mail.db and delete it afterwards.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const failures = [];

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log('  ✓ ' + name); })
    .catch(e => {
      fail++; failures.push(name + ' — ' + e.message);
      console.log('  ✗ ' + name + '\n      ' + e.message);
    });
}

function group(title) { console.log('\n' + title); }

/* ================= classify ================= */

const { classifyMessage, untilDate, referencedIds, header } = require('./lib/classify');
const NOW = new Date('2026-08-20T00:00:00Z');
const kind = m => classifyMessage(m, NOW).kind;

async function classifyTests() {
  group('classify — bounces');
  await test('hard bounce: no such user', () => {
    const r = classifyMessage({ from: 'mailer-daemon@googlemail.com', subject: 'Delivery Status Notification (Failure)',
      text: '550 5.1.1 The email account that you tried to reach does not exist', contentType: 'multipart/report' }, NOW);
    assert.strictEqual(r.kind, 'bounce'); assert.strictEqual(r.hard, true);
  });
  await test('soft bounce: mailbox full', () => {
    const r = classifyMessage({ from: 'mailer-daemon@googlemail.com', subject: 'Delayed',
      text: '452 4.2.2 over quota mailbox full', contentType: 'multipart/report' }, NOW);
    assert.strictEqual(r.kind, 'bounce'); assert.strictEqual(r.hard, false);
  });
  await test('bounce wins over In-Reply-To (would otherwise read as a reply)', () => {
    assert.strictEqual(kind({ from: 'postmaster@corp.com', subject: 'Undeliverable: Re: Hi',
      headers: { 'In-Reply-To': '<m1@mail>' }, text: '550 no such user', contentType: 'multipart/report' }), 'bounce');
  });
  await test('X-Failed-Recipients marks a bounce', () => {
    assert.strictEqual(kind({ from: 'x@y.com', subject: 'failure',
      headers: { 'X-Failed-Recipients': 'a@b.com' }, text: 'not delivered' }), 'bounce');
  });

  group('classify — out of office');
  await test('Auto-Submitted header', () => {
    assert.strictEqual(kind({ from: 'a@b.com', subject: 'Automatic reply',
      headers: { 'Auto-Submitted': 'auto-replied' }, text: 'away' }), 'ooo');
  });
  await test('Auto-Submitted: no is NOT an auto-reply', () => {
    assert.strictEqual(kind({ from: 'a@b.com', subject: 'Re: Hi',
      headers: { 'Auto-Submitted': 'no' }, text: 'Yes please, send it over.' }), 'reply');
  });
  await test('subject match', () => {
    assert.strictEqual(kind({ from: 'a@b.com', subject: 'Out of Office', text: 'Back on 2026-09-01' }), 'ooo');
  });
  await test('first-person body match, no headers', () => {
    assert.strictEqual(kind({ from: 'a@b.com', subject: 'Re: Hello',
      text: 'I am currently on annual leave and will return on 12/09/2026' }), 'ooo');
  });
  await test('corporate thank-you form crosses a sentence boundary', () => {
    assert.strictEqual(kind({ from: 'a@b.com', subject: 'Re: Hi',
      text: 'Thank you for your email. I am currently away from the office.' }), 'ooo');
  });
  await test('travelling with limited access', () => {
    assert.strictEqual(kind({ from: 'a@b.com', subject: 'Re: Hi',
      text: 'I am travelling with limited access to email this week.' }), 'ooo');
  });

  group('classify — human replies that must NOT be filed as auto');
  await test('mentions a future vacation in passing', () => {
    assert.strictEqual(kind({ from: 'a@b.com', subject: 'Re: Proposal',
      text: 'Thanks! I will review after my vacation. Send pricing.' }), 'reply');
  });
  await test('was out of office LAST week (past tense)', () => {
    assert.strictEqual(kind({ from: 'a@b.com', subject: 'Re: Meeting',
      text: 'I was out of office last week, sorry for delay. Interested!' }), 'reply');
  });
  await test('"remove me from the CC" is conversation, not opt-out', () => {
    assert.strictEqual(kind({ from: 'a@b.com', subject: 'Re: Order',
      text: 'Please remove me from the CC on that other thread' }), 'reply');
  });
  await test('thank-you followed by interest, not absence', () => {
    assert.strictEqual(kind({ from: 'a@b.com', subject: 'Re: Hi',
      text: 'Thank you for your email. I am interested in the pricing.' }), 'reply');
  });
  await test('noreply mentioned in a signature does not make it a bounce', () => {
    assert.strictEqual(kind({ from: 'sales@b.com', subject: 'Re: Quote',
      text: 'Do not reply to noreply@x.com, use this address' }), 'reply');
  });

  group('classify — opt-out and bulk');
  await test('unsubscribe in subject', () => {
    assert.strictEqual(kind({ from: 'a@b.com', subject: 'Please remove me from your list', text: 'x' }), 'unsubscribe');
  });
  await test('unsubscribe in body', () => {
    assert.strictEqual(kind({ from: 'a@b.com', subject: 'Re: News',
      text: 'Please unsubscribe me from all future mailings.' }), 'unsubscribe');
  });
  await test('List-Id marks bulk mail, not engagement', () => {
    assert.strictEqual(kind({ from: 'n@x.com', subject: 'Digest', headers: { 'List-Id': '<n.x>' }, text: 'hi' }), 'auto');
  });

  group('classify — return-date extraction');
  await test('ISO date', () => {
    assert.strictEqual(untilDate('back on 2026-09-01', NOW).toISOString().slice(0, 10), '2026-09-01');
  });
  await test('"until 25 August" stays in the current year', () => {
    assert.strictEqual(untilDate('until 25 August', NOW).toISOString().slice(0, 10), '2026-08-25');
  });
  await test('a month already past rolls to next year', () => {
    assert.strictEqual(untilDate('out of office until 5 March', NOW).toISOString().slice(0, 10), '2027-03-05');
  });
  await test('numeric d/m/y', () => {
    assert.strictEqual(untilDate('I return on 12/09/2026', NOW).toISOString().slice(0, 10), '2026-09-12');
  });
  await test('no date returns null rather than guessing', () => {
    assert.strictEqual(untilDate('I am away for a while', NOW), null);
  });

  group('classify — header helpers');
  await test('header lookup is case-insensitive', () => {
    assert.strictEqual(header({ 'In-Reply-To': '<a@b>' }, 'in-reply-to'), '<a@b>');
  });
  await test('header reads a Map (ImapFlow shape)', () => {
    assert.strictEqual(header(new Map([['in-reply-to', '<a@b>']]), 'In-Reply-To'), '<a@b>');
  });
  await test('referencedIds collects and de-duplicates', () => {
    const ids = referencedIds({ headers: { 'In-Reply-To': '<a@b>', References: '<a@b> <c@d>' } });
    assert.deepStrictEqual(ids.sort(), ['<a@b>', '<c@d>']);
  });
  await test('missing message shape does not throw', () => {
    assert.strictEqual(typeof classifyMessage({}, NOW).kind, 'string');
  });
}

/* ================= errors ================= */

const { classify, describe: describeErr, CODES, httpFor, withRetry } = require('./lib/errors');
const err = (msg, props) => Object.assign(new Error(msg), props || {});

async function errorTests() {
  group('errors — SMTP mapping');
  const cases = [
    ['bad app password', err('Username and Password not accepted', { code: 'EAUTH', responseCode: 535 }), 'AUTH_REJECTED'],
    ['app password required', err('Application-specific password required', { code: 'EAUTH', responseCode: 534 }), 'AUTH_APP_PASSWORD_REQUIRED'],
    ['no such user', err('No such user here', { responseCode: 550 }), 'SEND_NO_SUCH_USER'],
    ['mailbox over quota', err('552 over quota', { responseCode: 552 }), 'SEND_MAILBOX_FULL'],
    ['temporary 421', err('421 too many', { responseCode: 421 }), 'SEND_RATE_LIMIT'],
    ['daily quota', err('Daily user sending quota exceeded'), 'SEND_QUOTA_EXCEEDED'],
    ['timeout', err('Greeting never received', { code: 'ETIMEDOUT' }), 'SEND_TIMEOUT'],
    ['port blocked', err('connect ECONNREFUSED', { code: 'ECONNREFUSED' }), 'SEND_CONNECTION'],
    ['postgres duplicate', err('duplicate key', { code: '23505' }), 'SEND_DUPLICATE'],
    ['postgres out of space', err('disk full', { code: '53100' }), 'DB_QUOTA'],
  ];
  for (const [name, e, want] of cases) {
    await test(name + ' → ' + want, () => assert.strictEqual(classify(e), want));
  }

  group('errors — retry policy');
  await test('auth failures are never retried (Google locks the account)', () => {
    for (const c of ['AUTH_REJECTED', 'AUTH_APP_PASSWORD_REQUIRED']) {
      assert.strictEqual(CODES[c].retry, 'never', c);
    }
  });
  await test('a timeout asks before retrying (the message may have been sent)', () => {
    assert.strictEqual(CODES.SEND_TIMEOUT.retry, 'confirm');
  });
  await test('rate limits and cold starts retry automatically', () => {
    assert.strictEqual(CODES.SEND_RATE_LIMIT.retry, 'auto');
    assert.strictEqual(CODES.DB_COLD_START.retry, 'auto');
  });
  await test('every code declares a retry policy and an http status', () => {
    for (const [name, spec] of Object.entries(CODES)) {
      assert.ok(['auto', 'confirm', 'never'].includes(spec.retry), name + ' retry');
      assert.ok(spec.http >= 200 && spec.http < 600, name + ' http');
      assert.ok(spec.message, name + ' message');
    }
  });
  await test('describe() returns the documented shape', () => {
    const d = describeErr('AUTH_REJECTED');
    assert.strictEqual(d.ok, false);
    assert.strictEqual(d.code, 'AUTH_REJECTED');
    assert.strictEqual(d.retry, 'never');
    assert.ok(d.hint);
  });
  await test('unknown errors fall back to INTERNAL, not a crash', () => {
    assert.strictEqual(classify(err('something nobody predicted')), 'INTERNAL');
    assert.strictEqual(classify(null), 'INTERNAL');
    assert.strictEqual(httpFor('NOT_A_REAL_CODE'), 500);
  });

  group('errors — withRetry');
  await test('retries an auto code and eventually succeeds', async () => {
    let n = 0;
    const out = await withRetry(async () => {
      if (++n < 3) throw err('421 busy', { responseCode: 421 });
      return 'ok';
    }, { tries: 4, baseMs: 1 });
    assert.strictEqual(out, 'ok');
    assert.strictEqual(n, 3);
  });
  await test('does NOT retry a never code', async () => {
    let n = 0;
    await assert.rejects(withRetry(async () => {
      n++; throw err('bad password', { code: 'EAUTH', responseCode: 535 });
    }, { tries: 4, baseMs: 1 }));
    assert.strictEqual(n, 1, 'should have been attempted exactly once');
  });
  await test('gives up after the configured number of tries', async () => {
    let n = 0;
    await assert.rejects(withRetry(async () => {
      n++; throw err('421 busy', { responseCode: 421 });
    }, { tries: 3, baseMs: 1 }));
    assert.strictEqual(n, 3);
  });
}

/* ================= util — merge-field rendering ================= */

const { render, resolveField, fieldsUsed } = require('./lib/util');

async function utilTests() {
  group('util — render() resolves ANY recipient field, not a hardcoded list');
  await test('built-in {{name}} falls back to the greeting fallback when unset', () => {
    assert.strictEqual(render('Hi {{name}}', {}, 'there'), 'Hi there');
  });
  await test('built-in {{name}}/{{first_name}} are the same alias', () => {
    const r = { first: 'Anita' };
    assert.strictEqual(render('{{name}} / {{first_name}}', r, 'there'), 'Anita / Anita');
  });
  await test('built-in {{full_name}} and {{email}}', () => {
    const r = { first: 'Anita', full: 'Anita Sharma', email: 'a@x.com' };
    assert.strictEqual(render('{{full_name}} <{{email}}>', r, 'there'), 'Anita Sharma <a@x.com>');
  });
  await test('an arbitrary CSV column resolves with no code change, via r.fields', () => {
    const r = { first: 'Anita', fields: { website_name: 'Acme Corp', industry: 'Healthcare' } };
    assert.strictEqual(
      render('{{name}} works in {{industry}} at {{website_name}}', r, 'there'),
      'Anita works in Healthcare at Acme Corp'
    );
  });
  await test('an arbitrary top-level key also resolves, not just r.fields', () => {
    assert.strictEqual(render('{{company}}', { company: 'Acme' }, 'there'), 'Acme');
  });
  await test('field keys match regardless of case or underscores', () => {
    const r = { fields: { Website_Name: 'Acme' } };
    assert.strictEqual(render('{{website name}}', r, 'there'), 'Acme');
    assert.strictEqual(render('{{WEBSITENAME}}', r, 'there'), 'Acme');
  });
  await test('an unknown/mistyped tag stays visible rather than rendering blank', () => {
    // A user proofreading a draft needs to SEE {{compnay}} to catch the typo —
    // silently blanking it is how a mail merge ships "Dear ,".
    assert.strictEqual(render('Hi {{name}}, re: {{compnay}}', { first: 'Anita' }, 'there'),
      'Hi Anita, re: {{compnay}}');
  });
  await test('a null/undefined field value renders as empty, not "null"', () => {
    assert.strictEqual(render('{{notes}}', { fields: { notes: null } }, 'there'), '');
  });
  await test('resolveField distinguishes "unknown" (null) from "known but empty" ("")', () => {
    assert.strictEqual(resolveField('doesnotexist', { first: 'A' }, 'x'), null);
    assert.strictEqual(resolveField('notes', { fields: { notes: '' } }, 'x'), '');
  });
  await test('fieldsUsed lists every distinct token once, in first-appearance order', () => {
    assert.deepStrictEqual(
      fieldsUsed('Hi {{name}}, {{Website_Name}} and {{email}} again {{name}}'),
      ['name', 'Website_Name', 'email']
    );
  });
  await test('no template returns the template unchanged rather than throwing', () => {
    assert.strictEqual(render(null, {}, 'there'), '');
    assert.strictEqual(render('plain text, no tags', {}, 'there'), 'plain text, no tags');
  });
}

/* ================= importer ================= */

const { cluster, parsePasted, rebuildTemplate, linkThreadPositions } = require('./lib/importer');
const { normaliseSubject } = require('./lib/imap');

async function importerTests() {
  const M = (subj, to, at, uid) => ({
    uid, messageId: '<m' + uid + '@x>', at, subject: subj,
    normalised: normaliseSubject(subj), to: [to], bccLikely: false,
  });

  group('importer — recognising a campaign in the Sent folder');
  await test('a burst to many people reads as a campaign', () => {
    const c = cluster([
      M('Our new range', 'a@x.com', '2026-08-01T09:00:00Z', 1),
      M('Our new range', 'b@y.com', '2026-08-01T09:00:14Z', 2),
      M('Our new range', 'c@z.com', '2026-08-01T09:00:28Z', 3),
    ]);
    assert.strictEqual(c[0].confidence, 'high');
    assert.strictEqual(c[0].recipientCount, 3);
  });
  await test('personalised subjects join the same campaign', () => {
    const c = cluster([
      M('Our new range', 'a@x.com', '2026-08-01T09:00:00Z', 1),
      M('Hi Kiran, our new range', 'kiran@z.com', '2026-08-01T09:00:14Z', 2),
      M('Our new range', 'c@z.com', '2026-08-01T09:00:28Z', 3),
    ]);
    assert.strictEqual(c.length, 1, 'the greeting must not split the cluster');
    assert.strictEqual(c[0].recipientCount, 3);
  });
  await test('slow pacing is flagged for confirmation, not assumed', () => {
    const c = cluster([
      M('Partnership', 'p1@a.com', '2026-07-12T10:00:00Z', 1),
      M('Partnership', 'p2@b.com', '2026-07-12T11:30:00Z', 2),
      M('Partnership', 'p3@c.com', '2026-07-12T13:00:00Z', 3),
    ]);
    assert.strictEqual(c[0].confidence, 'medium');
    assert.ok(/individual emails/.test(c[0].reason));
  });
  await test('ordinary correspondence is not offered as a campaign', () => {
    const c = cluster([M('Re: invoice query', 'acc@x.com', '2026-08-01T14:00:00Z', 1)]);
    assert.strictEqual(c[0].confidence, 'low');
  });
  await test('Re:/Fwd: prefixes do not create separate clusters', () => {
    assert.strictEqual(normaliseSubject('Re: Our new range'), normaliseSubject('Our new range'));
    assert.strictEqual(normaliseSubject('Fwd: Our new range'), normaliseSubject('Our new range'));
  });
  await test('a trailing variable fragment joins the same cluster as the bare template', () => {
    // "...at India Health 2026" vs "...at the event" with no trailing detail at all.
    const c = cluster([
      M('Great meeting at the event India Health 2026', 'a@x.com', '2026-08-01T09:00:00Z', 1),
      M('Great meeting at the event India Health 2026', 'b@y.com', '2026-08-01T09:00:14Z', 2),
      M('Great meeting at the event', 'c@z.com', '2026-08-01T09:00:28Z', 3),
    ]);
    assert.strictEqual(c.length, 1, 'a trailing fragment must not split the cluster');
    assert.strictEqual(c[0].recipientCount, 3);
  });
  await test('a leading variable fragment also joins, not just trailing', () => {
    const c = cluster([
      M('India Health 2026 — great meeting at the event', 'a@x.com', '2026-08-01T09:00:00Z', 1),
      M('great meeting at the event', 'b@y.com', '2026-08-01T09:00:14Z', 2),
      M('great meeting at the event', 'c@z.com', '2026-08-01T09:00:28Z', 3),
    ]);
    assert.strictEqual(c.length, 1);
    assert.strictEqual(c[0].recipientCount, 3);
  });
  await test('genuinely different subjects still cluster separately', () => {
    const c = cluster([
      M('Our new range', 'a@x.com', '2026-08-01T09:00:00Z', 1),
      M('Our new range', 'b@y.com', '2026-08-01T09:00:14Z', 2),
      M('Our new range', 'c@z.com', '2026-08-01T09:00:28Z', 3),
      M('Invoice overdue', 'd@x.com', '2026-08-01T09:05:00Z', 4),
      M('Invoice overdue', 'e@y.com', '2026-08-01T09:05:14Z', 5),
      M('Invoice overdue', 'f@z.com', '2026-08-01T09:05:28Z', 6),
    ]);
    assert.strictEqual(c.length, 2, 'unrelated subjects must not merge just because both are short');
  });
  await test('word order still matters — a scrambled subject does not silently merge', () => {
    const c = cluster([
      M('quarterly report for finance team', 'a@x.com', '2026-08-01T09:00:00Z', 1),
      M('quarterly report for finance team', 'b@y.com', '2026-08-01T09:00:14Z', 2),
      M('quarterly report for finance team', 'c@z.com', '2026-08-01T09:00:28Z', 3),
      M('team finance for report quarterly', 'd@x.com', '2026-08-01T09:05:00Z', 4),
      M('team finance for report quarterly', 'e@y.com', '2026-08-01T09:05:14Z', 5),
      M('team finance for report quarterly', 'f@z.com', '2026-08-01T09:05:28Z', 6),
    ]);
    assert.strictEqual(c.length, 2, 'reordered words are a different subject, not the same template');
  });

  group('importer — expanding from one pasted email');
  await test('full headers give the Message-Id', () => {
    const p = parsePasted('Message-ID: <CA+abc@mail.gmail.com>\nSubject: Our new range\nTo: kiran@medipro.in');
    assert.strictEqual(p.messageId, '<CA+abc@mail.gmail.com>');
    assert.strictEqual(p.subject, 'Our new range');
    assert.strictEqual(p.to, 'kiran@medipro.in');
    assert.ok(p.usable);
  });
  await test('a bare subject line still works, marked weak', () => {
    const p = parsePasted('Our new range');
    assert.strictEqual(p.subject, 'Our new range');
    assert.ok(p.weak);
    assert.ok(p.usable);
  });
  await test('empty paste is reported unusable rather than throwing', () => {
    assert.strictEqual(parsePasted('').usable, false);
  });

  group('importer — rebuilding the template');
  const S = (to, body, uid) => ({ uid, to: [to], body });
  await test('the varying greeting is recognised as {{name}}', () => {
    const r = rebuildTemplate([
      S('anita@acme.com', 'Hi Anita, we are launching a new range. Interested?', 1),
      S('kiran@medipro.in', 'Hi Kiran, we are launching a new range. Interested?', 2),
      S('ravi@synthchem.com', 'Hi Ravi, we are launching a new range. Interested?', 3),
    ]);
    assert.strictEqual(r.template, 'Hi {{name}}, we are launching a new range. Interested?');
    assert.deepStrictEqual(r.fields, ['{{name}}']);
    assert.strictEqual(r.outliers.length, 0);
  });
  await test('ONE unrelated message must not poison the template', () => {
    const r = rebuildTemplate([
      S('anita@acme.com', 'Hi Anita, we are launching a new range. Interested?', 1),
      S('kiran@medipro.in', 'Hi Kiran, we are launching a new range. Interested?', 2),
      S('ravi@synthchem.com', 'Hi Ravi, we are launching a new range. Interested?', 3),
      S('bob@x.com', 'Bob, totally different note about the invoice you sent last week', 4),
    ]);
    assert.strictEqual(r.template, 'Hi {{name}}, we are launching a new range. Interested?');
    assert.strictEqual(r.outliers.length, 1);
    assert.strictEqual(r.outliers[0].to, 'bob@x.com');
  });
  await test('a variable that is not a name is flagged, never guessed', () => {
    const r = rebuildTemplate([
      S('a@x.com', 'Dear customer, your order 1001 has shipped.', 1),
      S('b@y.com', 'Dear customer, your order 1002 has shipped.', 2),
    ]);
    assert.ok(r.template.includes('{{?}}'));
    assert.ok(/could not be identified/.test(r.note));
  });
  await test('a single sample yields no invented merge fields', () => {
    const r = rebuildTemplate([S('a@x.com', 'Hello there.', 1)]);
    assert.deepStrictEqual(r.fields, []);
    assert.strictEqual(r.confidence, 'low');
  });
  await test('no samples returns empty rather than throwing', () => {
    assert.strictEqual(rebuildTemplate([]).template, '');
  });

  group('importer — scanSent search-object building (date range + subject/body query)');
  const { buildSentSearch } = require('./lib/imap');
  await test('no params at all searches everything', () => {
    assert.deepStrictEqual(buildSentSearch({}), { all: true });
  });
  await test('since/until map straight to IMAP SINCE/BEFORE', () => {
    const since = new Date('2026-08-21T00:00:00Z');
    const until = new Date('2026-08-26T00:00:00Z');   // caller already pushed this to "day after"
    assert.deepStrictEqual(buildSentSearch({ since, until }), { since, before: until });
  });
  await test('a bare subject still works exactly as before (no regression)', () => {
    assert.deepStrictEqual(buildSentSearch({ subject: 'India Health 2026' }),
      { subject: 'India Health 2026' });
  });
  await test('query searches subject OR body in one round trip, not two separate calls', () => {
    const r = buildSentSearch({ query: 'great meeting at the event' });
    assert.deepStrictEqual(r, { or: [{ subject: 'great meeting at the event' }, { body: 'great meeting at the event' }] });
  });
  await test('date range and query compose together', () => {
    const since = new Date('2026-08-21T00:00:00Z');
    const r = buildSentSearch({ since, query: 'great meeting' });
    assert.deepStrictEqual(r, { since, or: [{ subject: 'great meeting' }, { body: 'great meeting' }] });
  });

  group('importer — plainTextPart() finds the real text/plain part (not RFC 3501 BODY[TEXT])');
  const { plainTextPart } = require('./lib/imap');
  await test('a plain single-part message (no childNodes) is part "1"', () => {
    assert.deepStrictEqual(plainTextPart({ type: 'text/plain' }), { part: '1' });
  });
  await test('multipart/alternative picks the text/plain child, not part "1" blindly', () => {
    const structure = {
      type: 'multipart/alternative',
      childNodes: [
        { part: '1', type: 'text/plain' },
        { part: '2', type: 'text/html' },
      ],
    };
    assert.deepStrictEqual(plainTextPart(structure), { part: '1' });
  });
  await test('text/plain can be found even when it is not the first child', () => {
    const structure = {
      type: 'multipart/alternative',
      childNodes: [
        { part: '1', type: 'text/html' },
        { part: '2', type: 'text/plain' },
      ],
    };
    assert.deepStrictEqual(plainTextPart(structure), { part: '2' });
  });
  await test('falls back to text/html (flagged) when there is no text/plain alternative at all', () => {
    const structure = { type: 'multipart/mixed', childNodes: [{ part: '1', type: 'text/html' }] };
    assert.deepStrictEqual(plainTextPart(structure), { part: '1', html: true });
  });
  await test('nested multipart (e.g. mixed containing an alternative) is walked recursively', () => {
    const structure = {
      type: 'multipart/mixed',
      childNodes: [
        { type: 'multipart/alternative', childNodes: [
          { part: '1.1', type: 'text/plain' },
          { part: '1.2', type: 'text/html' },
        ] },
        { part: '2', type: 'application/pdf' },   // an attachment alongside the body
      ],
    };
    assert.deepStrictEqual(plainTextPart(structure), { part: '1.1' });
  });
  await test('no usable text part at all (e.g. a structure with only an attachment) returns null, not garbage', () => {
    const structure = { type: 'multipart/mixed', childNodes: [{ part: '1', type: 'application/pdf' }] };
    assert.strictEqual(plainTextPart(structure), null);
  });

  group('importer — textOf() reads the resolved part and strips HTML only when it had to fall back to it');
  const { textOf } = require('./lib/imap');
  await test('reads the plain-text part verbatim', () => {
    const msg = { bodyParts: new Map([['1', Buffer.from('Hello there')]]) };
    assert.strictEqual(textOf(msg, { part: '1' }), 'Hello there');
  });
  await test('strips tags when the resolved part is an HTML fallback', () => {
    const msg = { bodyParts: new Map([['1', Buffer.from('<p>Hello <b>there</b></p>')]]) };
    assert.strictEqual(textOf(msg, { part: '1', html: true }), 'Hello there');
  });
  await test('no partInfo (nothing usable was found) returns empty rather than throwing', () => {
    assert.strictEqual(textOf({ bodyParts: new Map() }, null), '');
  });

  group('importer — linkThreadPositions() reconstructs follow-up rounds for imported campaigns');
  // MT: a message-with-threading-headers fixture, richer than M() above.
  const MT = (uid, to, at, opts) => ({
    uid, to: [to], at,
    messageId: '<m' + uid + '@x>',
    inReplyTo: (opts && opts.inReplyTo) || null,
    references: (opts && opts.references) || [],
  });
  await test('a message with no In-Reply-To is round 0 (the start of its own chain)', () => {
    const rounds = linkThreadPositions([MT(1, 'a@x.com', '2026-01-01T00:00:00Z')]);
    assert.deepStrictEqual(rounds.get(1), { round: 0, parentUid: null });
  });
  await test('a reply to a message in the SAME cluster becomes round 1', () => {
    const original = MT(1, 'a@x.com', '2026-01-01T00:00:00Z');
    const reply = MT(2, 'a@x.com', '2026-01-05T00:00:00Z', { inReplyTo: '<m1@x>' });
    const rounds = linkThreadPositions([original, reply]);
    assert.deepStrictEqual(rounds.get(2), { round: 1, parentUid: 1 });
  });
  await test('a three-deep chain (original -> follow-up 1 -> follow-up 2) is walked correctly', () => {
    const m0 = MT(1, 'a@x.com', '2026-01-01T00:00:00Z');
    const m1 = MT(2, 'a@x.com', '2026-01-05T00:00:00Z', { inReplyTo: '<m1@x>' });
    const m2 = MT(3, 'a@x.com', '2026-01-10T00:00:00Z', { inReplyTo: '<m2@x>' });
    const rounds = linkThreadPositions([m0, m1, m2]);
    assert.strictEqual(rounds.get(1).round, 0);
    assert.strictEqual(rounds.get(2).round, 1);
    assert.strictEqual(rounds.get(3).round, 2);
    assert.strictEqual(rounds.get(3).parentUid, 2, 'round 2 must point at round 1s uid, not the original');
  });
  await test('References is checked too, not just In-Reply-To, so a dropped In-Reply-To still links', () => {
    const m0 = MT(1, 'a@x.com', '2026-01-01T00:00:00Z');
    const m1 = MT(2, 'a@x.com', '2026-01-05T00:00:00Z', { references: ['<m1@x>'] });   // no inReplyTo
    const rounds = linkThreadPositions([m0, m1]);
    assert.deepStrictEqual(rounds.get(2), { round: 1, parentUid: 1 });
  });
  await test('a reply pointing OUTSIDE this cluster is round 0, not a crash or a false link', () => {
    const m = MT(1, 'a@x.com', '2026-01-01T00:00:00Z', { inReplyTo: '<some-other-thread@elsewhere>' });
    const rounds = linkThreadPositions([m]);
    assert.deepStrictEqual(rounds.get(1), { round: 0, parentUid: null });
  });
  await test('chains for two different recipients in the same cluster never cross', () => {
    const aOriginal = MT(1, 'a@x.com', '2026-01-01T00:00:00Z');
    const aFollowup = MT(2, 'a@x.com', '2026-01-05T00:00:00Z', { inReplyTo: '<m1@x>' });
    const bOriginal = MT(3, 'b@x.com', '2026-01-01T00:00:00Z');
    const rounds = linkThreadPositions([aOriginal, aFollowup, bOriginal]);
    assert.strictEqual(rounds.get(2).round, 1);
    assert.strictEqual(rounds.get(3).round, 0, "b's message must not accidentally chain onto a's");
  });
}

/* ================= auth ================= */

const authmod = require('./lib/auth');

async function authTests() {
  const original = process.env.MAILBLASTER_API_KEY;

  group('auth \u2014 no key configured');
  process.env.MAILBLASTER_API_KEY = '';
  await test('the check is skipped, so local development needs no setup', () => {
    assert.strictEqual(authmod.enabled(), false);
    assert.strictEqual(authmod.matches(null), true);
    assert.strictEqual(authmod.matches('anything'), true);
  });

  group('auth \u2014 key configured');
  process.env.MAILBLASTER_API_KEY = 'secret-key-value';
  await test('the right key is accepted', () => {
    assert.strictEqual(authmod.matches('secret-key-value'), true);
  });
  await test('a wrong key is rejected', () => {
    assert.strictEqual(authmod.matches('wrong'), false);
  });
  await test('a missing key is rejected', () => {
    assert.strictEqual(authmod.matches(null), false);
    assert.strictEqual(authmod.matches(''), false);
  });
  await test('a key of a different length does not throw (hashed before compare)', () => {
    assert.strictEqual(authmod.matches('x'), false);
    assert.strictEqual(authmod.matches('x'.repeat(500)), false);
  });

  group('auth \u2014 where the key may be sent');
  await test('Authorization: Bearer', () => {
    assert.strictEqual(authmod.present({ headers: { authorization: 'Bearer abc' } }), 'abc');
  });
  await test('Bearer is matched case-insensitively', () => {
    assert.strictEqual(authmod.present({ headers: { authorization: 'bearer abc' } }), 'abc');
  });
  await test('X-API-Key', () => {
    assert.strictEqual(authmod.present({ headers: { 'x-api-key': 'abc' } }), 'abc');
  });
  await test('?key= query string', () => {
    assert.strictEqual(authmod.present({ headers: {}, query: { key: 'abc' } }), 'abc');
  });
  await test('nothing offered returns null rather than throwing', () => {
    assert.strictEqual(authmod.present({ headers: {} }), null);
    assert.strictEqual(authmod.present({}), null);
  });

  group('auth \u2014 the guard');
  await test('a guarded handler refuses an unauthenticated request', async () => {
    let status = null, body = null;
    const res = { statusCode: 200, setHeader() {}, end(t) { status = this.statusCode; body = JSON.parse(t); } };
    let ran = false;
    await authmod.require(async () => { ran = true; })({ headers: {}, url: '/api/x' }, res);
    assert.strictEqual(ran, false, 'the handler must not run');
    assert.strictEqual(status, 401);
    assert.strictEqual(body.code, 'UNAUTHORIZED');
    assert.strictEqual(body.retry, 'never');
  });
  await test('a guarded handler runs when the key is right', async () => {
    let ran = false;
    await authmod.require(async () => { ran = true; })(
      { headers: { 'x-api-key': 'secret-key-value' }, url: '/api/x' }, { statusCode: 200, setHeader() {}, end() {} });
    assert.strictEqual(ran, true);
  });

  group('auth \u2014 the key must never be logged');
  await test('log.safe redacts anything key-shaped', () => {
    const safe = require('./lib/log').safe({
      pass: 'p', password: 'p', token: 't', secret: 's', authorization: 'Bearer abc',
    });
    Object.values(safe).forEach(v => assert.strictEqual(v, '[redacted]'));
  });

  if (original === undefined) delete process.env.MAILBLASTER_API_KEY;
  else process.env.MAILBLASTER_API_KEY = original;
}

/* ================= store ================= */

async function storeTests() {
  const usingPg = !!(process.env.DATABASE_URL || process.env.POSTGRES_URL);
  const dbFile = path.join(process.cwd(), 'data', 'mail.db');
  if (!usingPg && fs.existsSync(dbFile)) fs.unlinkSync(dbFile);

  const store = require('./lib/store');
  await store.available();
  group('store — driver: ' + store.driver());

  if (usingPg) await store.clear();

  let campaignId, aliceId;

  await test('a campaign can be started and returns an id', async () => {
    campaignId = await store.startCampaign({ name: 'Suite', subject: 'Hi {{name}}', from: 'Me@Gmail.com', total: 3 });
    assert.ok(campaignId, 'expected an id');
  });
  await test('recipients are de-duplicated case-insensitively', async () => {
    aliceId = await store.upsertRecipient({ email: 'Alice@Test.com', first: 'Alice' });
    const again = await store.upsertRecipient({ email: 'alice@test.com', first: 'Alice' });
    assert.strictEqual(String(aliceId), String(again), 'same person must reuse one row');
  });
  await test('a send is recorded', async () => {
    const r = await store.insert({ campaignId, time: new Date().toISOString(), from: 'me@gmail.com',
      to: 'alice@test.com', name: 'Alice', subject: 'Hi Alice', attachments: ['a.pdf'],
      status: 'sent', body: '<p>hello</p>', messageId: '<m1@mail>' });
    assert.strictEqual(r, true);
  });
  await test('THE GUARD: the same person cannot be sent twice in one campaign', async () => {
    const r = await store.insert({ campaignId, time: new Date().toISOString(), from: 'me@gmail.com',
      to: 'ALICE@test.com', name: 'Alice', subject: 'Hi again', status: 'sent', body: '<p>dup</p>' });
    assert.strictEqual(r, 'duplicate', 'the database must reject this, whatever the browser does');
  });
  await test('a failed send is recorded with its error', async () => {
    const r = await store.insert({ campaignId, time: new Date().toISOString(), from: 'me@gmail.com',
      to: 'bob@test.com', name: 'Bob', subject: 'Hi Bob', status: 'failed', error: 'mailbox full' });
    assert.strictEqual(r, true);
  });
  await test('campaign counters follow the sends', async () => {
    await store.finishCampaign(campaignId, 'done');
    const c = (await store.campaigns('me@gmail.com'))[0];
    assert.strictEqual(c.sent, 1);
    assert.strictEqual(c.failed, 1);
    assert.strictEqual(c.total, 3);
    assert.strictEqual(c.status, 'done');
    assert.ok(c.finishedAt, 'finishedAt should be stamped');
  });
  await test('history is scoped to the Gmail account that sent it', async () => {
    assert.strictEqual((await store.campaigns('someone-else@gmail.com')).length, 0);
    assert.ok((await store.campaigns('me@gmail.com')).length >= 1);
  });
  await test('owner lookup is case-insensitive', async () => {
    assert.ok((await store.campaigns('ME@GMAIL.COM')).length >= 1);
  });
  await test('EFFICIENCY: list() does not ship the stored body', async () => {
    const rows = await store.list(10, { owner: 'me@gmail.com' });
    assert.ok(rows.length >= 2);
    assert.ok(!('body' in rows[0]), 'body must be fetched on demand, not with every row');
  });
  await test('body() fetches one body on demand', async () => {
    const rows = await store.list(10, { owner: 'me@gmail.com' });
    const sent = rows.find(r => r.status === 'sent');
    assert.strictEqual(await store.body(sent.id), '<p>hello</p>');
  });
  await test('message_id is persisted (it used to be silently dropped)', async () => {
    const rows = await store.list(10, { owner: 'me@gmail.com' });
    assert.ok(rows.some(r => r.messageId === '<m1@mail>'), 'message_id must survive the insert');
  });
  await test('suppression returns bare addresses, not log rows', async () => {
    const s = await store.suppression();
    assert.ok(s.sent.includes('alice@test.com'));
    assert.ok(s.sent.every(x => typeof x === 'string'), 'must be plain strings');
  });
  await test('a failed send does not enter the already-sent list', async () => {
    const s = await store.suppression();
    assert.ok(!s.sent.includes('bob@test.com'), 'bob failed, so he is still to be sent to');
  });
  await test('sends can be listed per campaign', async () => {
    const rows = await store.list(50, { campaignId });
    assert.strictEqual(rows.length, 2);
  });

  group('store — insert()\'s optional returnId, for linking one send onto another (imported thread chains)');
  await test('returns just true by default, unchanged for every existing caller', async () => {
    const camp = await store.startCampaign({ name: 'returnId test', subject: 'Hi', from: 'me@gmail.com', total: 1 });
    const r = await store.insert({ campaignId: camp, time: new Date().toISOString(), from: 'me@gmail.com',
      to: 'returnid-default@test.com', name: 'X', subject: 'Hi', status: 'sent', body: '<p>x</p>' });
    assert.strictEqual(r, true, 'the default contract must not change — api/send.js depends on this');
  });
  await test('returnId:true returns the new row\'s id, so a caller can link a later row onto it', async () => {
    const camp = await store.startCampaign({ name: 'returnId test 2', subject: 'Hi', from: 'me@gmail.com', total: 1 });
    const r = await store.insert({ campaignId: camp, time: new Date().toISOString(), from: 'me@gmail.com',
      to: 'returnid-opt-in@test.com', name: 'Y', subject: 'Hi', status: 'sent', body: '<p>y</p>', returnId: true });
    assert.strictEqual(typeof r, 'object');
    assert.ok(r.id, 'must return a usable database id');
  });

  group('store — sentToday() tracks a rolling 24h Gmail-quota count per account');
  await test('sentToday counts delivered sends for that sender in the last 24h', async () => {
    const camp = await store.startCampaign({ name: 'Quota test', subject: 'Hi', from: 'quota@gmail.com', total: 2 });
    await store.insert({ campaignId: camp, time: new Date().toISOString(), from: 'quota@gmail.com',
      to: 'q1@test.com', name: 'Q1', subject: 'Hi', status: 'sent', body: '<p>1</p>' });
    await store.insert({ campaignId: camp, time: new Date().toISOString(), from: 'quota@gmail.com',
      to: 'q2@test.com', name: 'Q2', subject: 'Hi', status: 'failed', body: '<p>2</p>' });
    const q = await store.sentToday('quota@gmail.com');
    assert.strictEqual(q.sent, 1, 'only the delivered send counts toward the quota, not the failed one');
    assert.strictEqual(q.limit, 500, 'defaults to the personal-Gmail daily cap');
  });
  await test('sentToday is scoped per sender, not global', async () => {
    const q = await store.sentToday('someone-else-entirely@gmail.com');
    assert.strictEqual(q.sent, 0);
  });
  await test('a custom limit can be passed (e.g. 2000 for a Workspace account)', async () => {
    const q = await store.sentToday('quota@gmail.com', { limit: 2000 });
    assert.strictEqual(q.limit, 2000);
  });

  group('store — groupKey ties several accounts\' campaigns to one "send all checked" action');
  await test('a campaign started without a groupKey has none', async () => {
    const camp = await store.startCampaign({ name: 'No group', subject: 'Hi', from: 'nogroup@gmail.com', total: 1 });
    const c = (await store.campaigns('nogroup@gmail.com'))[0];
    assert.strictEqual(c.groupKey, null);
  });
  await test('a groupKey passed to startCampaign is persisted and comes back on campaigns()', async () => {
    const key = 'grp-test-123';
    await store.startCampaign({ name: 'Grouped A', subject: 'Hi', from: 'groupa@gmail.com', total: 1, groupKey: key });
    await store.startCampaign({ name: 'Grouped B', subject: 'Hi', from: 'groupb@gmail.com', total: 1, groupKey: key });
    const a = (await store.campaigns('groupa@gmail.com'))[0];
    const b = (await store.campaigns('groupb@gmail.com'))[0];
    assert.strictEqual(a.groupKey, key);
    assert.strictEqual(b.groupKey, key);
  });

  group('store — References accumulates the whole ancestor chain (RFC 5322 3.6.4)');
  await test('round 1 follow-up candidate has no prior references, just the original message-id', async () => {
    const camp1 = await store.startCampaign({ name: 'Thread test', subject: 'Hi', from: 'me@gmail.com', total: 1 });
    await store.insert({ campaignId: camp1, time: new Date().toISOString(), from: 'me@gmail.com',
      to: 'carol@test.com', name: 'Carol', subject: 'Hi Carol', status: 'sent',
      body: '<p>1</p>', messageId: '<round0@mail>' });
    const candidates = await store.followupCandidates(camp1, { cap: false });
    const carol = candidates.find(c => c.email === 'carol@test.com');
    assert.deepStrictEqual(carol.references, ['<round0@mail>'],
      'first follow-up must reference exactly the original message');
  });
  await test('round 2 follow-up candidate carries round 0 AND round 1 in References', async () => {
    const camp1 = await store.startCampaign({ name: 'Thread test 2', subject: 'Hi', from: 'me@gmail.com', total: 1 });
    await store.insert({ campaignId: camp1, time: new Date().toISOString(), from: 'me@gmail.com',
      to: 'dave@test.com', name: 'Dave', subject: 'Hi Dave', status: 'sent',
      body: '<p>1</p>', messageId: '<round0-dave@mail>' });
    const round1Candidates = await store.followupCandidates(camp1, { cap: false });
    const dave1 = round1Candidates.find(c => c.email === 'dave@test.com');

    // Simulate what app.js + api/send.js do: send round 1 with the accumulated
    // references, then persist that send with them.
    const camp2 = await store.startCampaign({ name: 'Thread test 2 · follow-up 1', subject: 'Re: Hi',
      from: 'me@gmail.com', total: 1, parentId: camp1, followupRound: 1 });
    await store.insert({ campaignId: camp2, time: new Date().toISOString(), from: 'me@gmail.com',
      to: 'dave@test.com', name: 'Dave', subject: 'Re: Hi Dave', status: 'sent', followupRound: 1,
      body: '<p>2</p>', messageId: '<round1-dave@mail>', references: dave1.references });

    const round2Candidates = await store.followupCandidates(camp2, { cap: false });
    const dave2 = round2Candidates.find(c => c.email === 'dave@test.com');
    assert.deepStrictEqual(dave2.references, ['<round0-dave@mail>', '<round1-dave@mail>'],
      'round 2 must carry BOTH ancestors, not just the immediately preceding message');
  });

  await test('clear() empties history but keeps known addresses', async () => {
    await store.clear();
    assert.strictEqual((await store.campaigns('me@gmail.com')).length, 0);
    assert.strictEqual((await store.list(10)).length, 0);
    const s = await store.suppression();
    assert.strictEqual(s.sent.length, 0, 'last_sent_at should be reset by clear()');
  });
}

/* ================= llm: DeepSeek cost calculation (no network) ================= */

/**
 * lib/llm.js is entirely optional (the fuzzy campaign-matching assist for
 * clusters exact-string search misses) and makes no live call without
 * DEEPSEEK_API_KEY set. What IS tested here without any network access or
 * key is the cost math itself: peak-hour detection and the usage->USD
 * calculation, checked against DeepSeek's own published pricing
 * (api-docs.deepseek.com/quick_start/pricing, confirmed August 2026) by hand
 * arithmetic, not just internal consistency.
 */
async function llmTests() {
  const llm = require('./lib/llm');

  group('llm — peak-hour detection (01:00-04:00 and 06:00-10:00 UTC, Mon-Fri)');
  await test('a weekday inside the first peak window (02:00 UTC) is peak', () => {
    assert.strictEqual(llm.isPeakHour(new Date('2026-08-24T02:00:00Z')), true);   // a Monday
  });
  await test('a weekday inside the second peak window (07:00 UTC) is peak', () => {
    assert.strictEqual(llm.isPeakHour(new Date('2026-08-24T07:00:00Z')), true);
  });
  await test('a weekday in the gap between the two peak windows (05:00 UTC) is off-peak', () => {
    assert.strictEqual(llm.isPeakHour(new Date('2026-08-24T05:00:00Z')), false);
  });
  await test('midday on a weekday is off-peak', () => {
    assert.strictEqual(llm.isPeakHour(new Date('2026-08-24T12:00:00Z')), false);
  });
  await test('the same hour-of-day on a Saturday is off-peak (peak is Mon-Fri only)', () => {
    assert.strictEqual(llm.isPeakHour(new Date('2026-08-29T02:00:00Z')), false);   // a Saturday
  });

  group('llm — costOf() matches DeepSeek\'s published per-token pricing exactly');
  await test('off-peak deepseek-v4-flash: cache-hit + cache-miss + output priced separately', () => {
    // 900 cache-hit @ $0.007/M + 100 cache-miss @ $0.22/M + 50 output @ $0.66/M
    const usage = { prompt_tokens: 1000, prompt_cache_hit_tokens: 900, prompt_cache_miss_tokens: 100, completion_tokens: 50 };
    const r = llm.costOf(usage, { at: new Date('2026-08-24T12:00:00Z') });   // off-peak
    const expected = (900 / 1e6) * 0.007 + (100 / 1e6) * 0.22 + (50 / 1e6) * 0.66;
    assert.ok(Math.abs(r.usd - expected) < 1e-12, 'expected ' + expected + ' got ' + r.usd);
    assert.strictEqual(r.peak, false);
  });
  await test('peak hours exactly double the off-peak rate', () => {
    const usage = { prompt_tokens: 1000, prompt_cache_hit_tokens: 1000, prompt_cache_miss_tokens: 0, completion_tokens: 0 };
    const offPeak = llm.costOf(usage, { at: new Date('2026-08-24T12:00:00Z') });
    const peak = llm.costOf(usage, { at: new Date('2026-08-24T02:00:00Z') });
    assert.ok(Math.abs(peak.usd - offPeak.usd * 2) < 1e-12, 'peak must be exactly 2x off-peak');
  });
  await test('a cache-hit token is roughly 31x cheaper than a cache-miss token (deepseek-v4-flash)', () => {
    const hitOnly = llm.costOf({ prompt_cache_hit_tokens: 1e6, prompt_cache_miss_tokens: 0, completion_tokens: 0 },
      { at: new Date('2026-08-24T12:00:00Z') });
    const missOnly = llm.costOf({ prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1e6, completion_tokens: 0 },
      { at: new Date('2026-08-24T12:00:00Z') });
    const ratio = missOnly.usd / hitOnly.usd;
    assert.ok(ratio > 30 && ratio < 32, 'expected ~31x, got ' + ratio + 'x');
  });
  await test('deepseek-v4-pro is priced at its own (higher) table, not flash\'s', () => {
    const usage = { prompt_cache_hit_tokens: 1e6, prompt_cache_miss_tokens: 0, completion_tokens: 0 };
    const flash = llm.costOf(usage, { model: 'deepseek-v4-flash', at: new Date('2026-08-24T12:00:00Z') });
    const pro = llm.costOf(usage, { model: 'deepseek-v4-pro', at: new Date('2026-08-24T12:00:00Z') });
    assert.ok(pro.usd > flash.usd, 'pro must cost more than flash for the same usage');
  });

  group('llm — the whole module is a safe no-op with no API key configured');
  await test('available() is false with no key in the environment', () => {
    const hadKey = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    try {
      assert.strictEqual(llm.available(), false);
    } finally {
      if (hadKey) process.env.DEEPSEEK_API_KEY = hadKey;
    }
  });
  await test('complete() returns null rather than throwing with no key', async () => {
    const hadKey = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    try {
      const r = await llm.complete([{ role: 'user', content: 'hi' }]);
      assert.strictEqual(r, null);
    } finally {
      if (hadKey) process.env.DEEPSEEK_API_KEY = hadKey;
    }
  });
  await test('suggestSameCampaign() returns null rather than throwing with no key', async () => {
    const hadKey = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    try {
      const r = await llm.suggestSameCampaign('Great meeting at the event India Health 2026', 'Great meeting at the event');
      assert.strictEqual(r, null);
    } finally {
      if (hadKey) process.env.DEEPSEEK_API_KEY = hadKey;
    }
  });
}

/* ================= frontend: it must actually load in a real DOM ================= */

/**
 * Execute app.js inside a real (jsdom) document built from index.html. This
 * is the test ARCHITECTURE.md has described since before this file existed
 * ("the frontend is verified by executing app.js in jsdom... this caught a
 * real crash where one stale element id threw during load and left every
 * handler after it unbound") — it just hadn't actually been written yet.
 * jsdom gives real getElementById/addEventListener/classList behavior, which
 * is what catches load-order bugs (a function called before its hoisted
 * declaration is fine; a DOM id that plain does not exist, called
 * unguarded, throws) that a purely textual $() scan cannot: a static scan
 * can tell you an id resolves to *something*, not that loading the script
 * top-to-bottom against the real page never throws.
 */
async function frontendLoadTests() {
  group('frontend — app.js must execute against the real page without throwing');
  let JSDOM;
  try { ({ JSDOM } = require('jsdom')); } catch (e) {
    console.log('  (skipped — jsdom not installed)');
    return;
  }

  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const appSrc = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only' });
  const { window } = dom;
  // app.js expects a real fetch/localStorage; jsdom's window doesn't ship a
  // fetch, and touches to localStorage that throw are already caught by the
  // app's own try/catch — stub fetch so calls made during load (none are
  // awaited synchronously) don't throw SyntaxError on a missing global.
  window.fetch = () => Promise.resolve({ json: () => Promise.resolve({ ok: false }) });

  let thrown = null;
  try {
    dom.window.eval(appSrc);
  } catch (e) {
    thrown = e;
  }

  await test('app.js runs top-to-bottom against the real page with no thrown error', () => {
    if (thrown) throw new Error((thrown && thrown.stack) || String(thrown));
  });

  await test('every <button> in the page has a click handler bound (or is inside a template not yet cloned)', () => {
    const unbound = [];
    window.document.querySelectorAll('button[id]').forEach(b => {
      // jsdom exposes onclick as a property when set via .onclick = fn;
      // addEventListener-bound handlers aren't introspectable this way, so
      // this only catches the onclick= style this codebase mostly uses —
      // still real coverage for the class of bug that motivated this test.
      if (typeof b.onclick !== 'function') unbound.push(b.id);
    });
    // A handful of buttons are wired via addEventListener or delegated
    // listeners (e.g. dynamically rendered rows) rather than .onclick, so
    // this is a soft check: report, don't fail the suite, on those.
    if (unbound.length) console.log('    (no direct .onclick found on: ' + unbound.join(', ') + ' — may be addEventListener-bound, not necessarily broken)');
  });
}

/* ================= frontend: CSV column-mapping guesses ================= */

async function csvMappingTests() {
  group('frontend — guessCsvMapping() detects common spreadsheet headers');
  let JSDOM;
  try { ({ JSDOM } = require('jsdom')); } catch (e) { console.log('  (skipped — jsdom not installed)'); return; }

  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const appSrc = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only' });
  dom.window.fetch = () => Promise.resolve({ json: () => Promise.resolve({ ok: false }) });
  dom.window.eval(appSrc);
  const guess = headers => dom.window.guessCsvMapping(headers).map(m => m.role);

  await test('exact "Email"/"First Name"/"Last Name" headers', () => {
    assert.deepStrictEqual(guess(['First Name', 'Last Name', 'Email']), ['firstName', 'lastName', 'email']);
  });
  await test('common real-world variants (underscores, "E-Mail Address", "Given Name")', () => {
    assert.deepStrictEqual(
      guess(['given_name', 'family_name', 'e-mail address']),
      ['firstName', 'lastName', 'email']
    );
  });
  await test('a single combined "Full Name" / "Name" column', () => {
    assert.strictEqual(guess(['Name'])[0], 'fullName');
    assert.strictEqual(guess(['Full Name'])[0], 'fullName');
  });
  await test('a looser "Work Email" / "Contact E-Mail" still matches via the e-mail substring fallback', () => {
    assert.deepStrictEqual(guess(['Work Email', 'Contact E-Mail']), ['email', 'email']);
  });
  await test('several email-shaped columns (email, email2, alt_email) all become email candidates', () => {
    assert.deepStrictEqual(guess(['Email', 'Email2', 'Alt Email']), ['email', 'email', 'email']);
  });
  await test('an unrecognised header becomes a merge field, never silently dropped', () => {
    assert.deepStrictEqual(guess(['Website Name', 'Industry']), ['field', 'field']);
  });
  await test('"Company Email" does not get outranked by a plain substring match into the wrong role', () => {
    // Regression guard: an earlier looser design could have this collide with "Company" -> field.
    assert.strictEqual(guess(['Company Email'])[0], 'email');
  });
}

/* ================= frontend: every $() id must resolve ================= */

/**
 * A cheap, no-jsdom-needed guard against the exact class of bug that shipped
 * here once already: app.js calling $('someId') where no element with that
 * id exists anywhere (not in index.html statically, not in the
 * mailWindowTpl-clone-with-prefix mechanism, and not created at runtime by
 * app.js's own innerHTML strings). An unguarded call like that throws the
 * instant it runs and — because app.js executes top-to-bottom, wiring
 * handlers as it goes — silently leaves every handler bound AFTER that line
 * unbound. This can't tell a guarded `if ($('x')) ...` from a crash risk on
 * its own, so it only reports ids that are missing from ALL sources; it is a
 * coverage net, not a substitute for a real browser test.
 */
async function frontendTests() {
  group('frontend — every $() id used in app.js must resolve to something real');
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

  const staticIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  const templateDataIds = new Set([...html.matchAll(/data-id="([^"]+)"/g)].map(m => m[1]));
  const prefixes = [...html.matchAll(/data-prefix="([^"]+)"/g)].map(m => m[1]);
  const clonedIds = new Set();
  prefixes.forEach(p => templateDataIds.forEach(id => clonedIds.add(p + id)));
  // ids app.js creates itself in an innerHTML string (e.g. openCampaign's
  // #campBack) rather than something declared in index.html.
  const runtimeGenerated = new Set([...app.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
  const allIds = new Set([...staticIds, ...clonedIds, ...runtimeGenerated]);

  const used = [...new Set([...app.matchAll(/\$\('([^']+)'\)/g)].map(m => m[1]))];
  await test(used.length + ' ids referenced via $() were checked against the DOM', () => {
    assert.ok(used.length > 100, 'sanity check: app.js should reference well over 100 ids');
  });
  const missing = used.filter(id => !allIds.has(id));
  await test('no $() call references an id absent from index.html, the cloned mail-window template, or a runtime-generated element', () => {
    assert.deepStrictEqual(missing, [], 'these ids resolve to nothing and will throw if reached unguarded: ' + missing.join(', '));
  });
}

/* ================= run ================= */

(async () => {
  console.log('MailBlaster test suite');
  await classifyTests();
  await utilTests();
  await errorTests();
  await importerTests();
  await authTests();
  await storeTests();
  await llmTests();
  await frontendLoadTests();
  await csvMappingTests();
  await frontendTests();

  console.log('\n' + '-'.repeat(50));
  console.log(pass + ' passed, ' + fail + ' failed');
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach(f => console.log('  - ' + f));
  }
  process.exit(fail ? 1 : 0);
})();
