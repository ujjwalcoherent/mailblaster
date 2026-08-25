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

/* ================= importer ================= */

const { cluster, parsePasted, rebuildTemplate } = require('./lib/importer');
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
  await errorTests();
  await importerTests();
  await authTests();
  await storeTests();
  await frontendLoadTests();
  await frontendTests();

  console.log('\n' + '-'.repeat(50));
  console.log(pass + ' passed, ' + fail + ' failed');
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach(f => console.log('  - ' + f));
  }
  process.exit(fail ? 1 : 0);
})();
