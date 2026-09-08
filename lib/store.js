'use strict';

/**
 * Send log and campaign history, with three drivers picked at runtime:
 *
 *   postgres  — used when DATABASE_URL / POSTGRES_URL is set. The only driver
 *               that gives a shared, durable history on Vercel: every visitor
 *               and every device sees the same data.
 *   sqlite    — local development, via node:sqlite (built into Node 22.5+).
 *               Writes to ./data/mail.db. Cannot work on Vercel: the
 *               filesystem there is read-only.
 *   none      — no database configured and no writable disk. The browser
 *               falls back to its own localStorage copy, which is per-browser
 *               and therefore cannot deduplicate across devices.
 *
 * De-duplication lives in the database, not the browser. `recipients` holds
 * one row per address ever seen, carrying lifetime state (replied, bounced,
 * unsubscribed), and UNIQUE constraints make a double-send impossible even if
 * two tabs run at once. See lib/schema.sql.
 */

const path = require('path');
const fs = require('fs');

let driver = null;      // 'postgres' | 'sqlite' | 'none'
let db = null;          // sqlite handle
let sql = null;         // postgres query function (tagged template)
let reason = 'not initialised';
let ready = null;       // in-flight init promise

const CONN = () => process.env.DATABASE_URL || process.env.POSTGRES_URL || '';

/** Normalise a row from either driver into the shape the browser expects. */
const ROW = e => ({
  id: e.id,
  time: e.time instanceof Date ? e.time.toISOString() : e.time,
  from: e.sender || e.from || '',
  to: e.recipient || e.to || '',
  name: e.name || '',
  subject: e.subject || '',
  attachments: typeof e.attachments === 'string' ? JSON.parse(e.attachments || '[]') : (e.attachments || []),
  status: e.status || '',
  error: e.error || null,
  campaignId: e.campaign_id || null,
  messageId: e.message_id || null,
});

/* ---------- schema ---------- */

/* Split schema.sql into statements. Every statement is IF NOT EXISTS or
   additive, so running this on each cold start is safe and means a git push
   migrates the live database with no manual step. */
function schemaStatements() {
  const raw = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  return raw.replace(/^\s*--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean);
}

async function initPostgres() {
  const { neon } = require('@neondatabase/serverless');
  const q = neon(CONN());
  for (const stmt of schemaStatements()) await q.query(stmt);
  sql = q;
  driver = 'postgres';
  reason = 'postgres';
}

/* The SQLite mirror of schema.sql. Kept deliberately close to it, minus the
   Postgres-only types, so local development exercises the same shape. */
function initSqlite() {
  const { DatabaseSync } = require('node:sqlite');
  const dir = path.join(process.cwd(), 'data');
  fs.mkdirSync(dir, { recursive: true });
  const handle = new DatabaseSync(path.join(dir, 'mail.db'));

  handle.exec(`CREATE TABLE IF NOT EXISTS campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT, subject_template TEXT, from_email TEXT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')), finished_at TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    sent_count INTEGER NOT NULL DEFAULT 0,
    failed_count INTEGER NOT NULL DEFAULT 0,
    total_count INTEGER NOT NULL DEFAULT 0,
    parent_id INTEGER,
    followup_round INTEGER NOT NULL DEFAULT 0,
    imported INTEGER NOT NULL DEFAULT 0,
    import_source TEXT,
    group_key TEXT
  )`);
  handle.exec(`CREATE TABLE IF NOT EXISTS recipients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    first_name TEXT, full_name TEXT, salutation_confidence TEXT,
    status TEXT NOT NULL DEFAULT 'new',
    do_not_contact INTEGER NOT NULL DEFAULT 0,
    replied_at TEXT, ooo_until TEXT,
    bounce_count INTEGER NOT NULL DEFAULT 0,
    followup_count INTEGER NOT NULL DEFAULT 0,
    contact_count INTEGER NOT NULL DEFAULT 0,
    last_followup_at TEXT,
    last_sent_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    fields TEXT
  )`);
  handle.exec(`CREATE TABLE IF NOT EXISTS sends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER, recipient_id INTEGER,
    time TEXT NOT NULL, sender TEXT, recipient TEXT, name TEXT, subject TEXT,
    attachments TEXT, status TEXT, error TEXT, body TEXT, message_id TEXT,
    in_reply_to_send INTEGER, followup_round INTEGER NOT NULL DEFAULT 0,
    imported INTEGER NOT NULL DEFAULT 0, references_json TEXT
  )`);
  handle.exec(`CREATE TABLE IF NOT EXISTS replies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recipient_id INTEGER, send_id INTEGER,
    received_at TEXT NOT NULL, from_email TEXT, subject TEXT, snippet TEXT,
    kind TEXT NOT NULL, in_reply_to TEXT, body TEXT,
    mailbox TEXT NOT NULL DEFAULT 'INBOX', imap_uid INTEGER
  )`);

  // migrations for databases created before these columns existed
  const add = (table, col, type) => {
    const have = handle.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    if (!have.includes(col)) handle.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  };
  for (const [col, type] of [['body', 'TEXT'], ['message_id', 'TEXT'],
                             ['campaign_id', 'INTEGER'], ['recipient_id', 'INTEGER'],
                             ['in_reply_to_send', 'INTEGER'],
                             ['followup_round', 'INTEGER NOT NULL DEFAULT 0'],
                             ['references_json', 'TEXT']]) {
    add('sends', col, type);
  }
  for (const [col, type] of [['parent_id', 'INTEGER'], ['followup_round', 'INTEGER NOT NULL DEFAULT 0'],
                             ['imported', 'INTEGER NOT NULL DEFAULT 0'], ['import_source', 'TEXT'],
                             ['group_key', 'TEXT']]) {
    add('campaigns', col, type);
  }
  add('sends', 'imported', 'INTEGER NOT NULL DEFAULT 0');
  for (const [col, type] of [['followup_count', 'INTEGER NOT NULL DEFAULT 0'],
                             ['contact_count', 'INTEGER NOT NULL DEFAULT 0'],
                             ['last_followup_at', 'TEXT'],
                             ['fields', 'TEXT']]) {
    add('recipients', col, type);
  }
  add('replies', 'body', 'TEXT');

  handle.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_sends_campaign_recipient ON sends(campaign_id, recipient_id) WHERE campaign_id IS NOT NULL AND recipient_id IS NOT NULL');
  handle.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_replies_uid ON replies(mailbox, imap_uid) WHERE imap_uid IS NOT NULL');
  handle.exec('CREATE INDEX IF NOT EXISTS idx_sends_time ON sends(time DESC)');
  handle.exec('CREATE INDEX IF NOT EXISTS idx_sends_message_id ON sends(message_id)');
  handle.exec('CREATE INDEX IF NOT EXISTS idx_sends_recipient ON sends(recipient_id, status)');
  handle.exec('CREATE INDEX IF NOT EXISTS idx_recip_dnc ON recipients(do_not_contact)');
  handle.exec('CREATE INDEX IF NOT EXISTS idx_campaigns_owner ON campaigns(from_email, started_at DESC)');
  handle.exec('CREATE INDEX IF NOT EXISTS idx_sends_sender_time ON sends(sender, time DESC)');
  handle.exec('CREATE INDEX IF NOT EXISTS idx_campaigns_group_key ON campaigns(group_key)');

  handle.exec(`CREATE TABLE IF NOT EXISTS accounts (
    email TEXT PRIMARY KEY,
    app_password_enc TEXT NOT NULL,
    from_name TEXT, reply_to TEXT,
    smtp_port TEXT NOT NULL DEFAULT '587',
    auto_scan_on_send INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  db = handle;
  driver = 'sqlite';
  reason = 'sqlite (data/mail.db)';
}

function init() {
  if (ready) return ready;
  ready = (async () => {
    if (CONN()) {
      try {
        await initPostgres();
        return driver;
      } catch (e) {
        reason = 'postgres failed: ' + e.message;
      }
    }
    try {
      initSqlite();
      return driver;
    } catch (e) {
      driver = 'none';
      reason = CONN()
        ? reason
        : 'no DATABASE_URL set and the filesystem is read-only (' + e.code + '). '
          + 'Add a Postgres database to share the log across devices.';
      return driver;
    }
  })();
  return ready;
}

async function available() {
  await init();
  return driver === 'postgres' || driver === 'sqlite';
}

/* ---------- recipients: the de-duplication authority ---------- */

/**
 * Find or create the row for an address and return its id. One row per
 * address ever, so lifetime state (replied / bounced / unsubscribed) survives
 * across campaigns and suppresses future sends.
 */
async function upsertRecipient(r) {
  await init();
  const email = String(r.email || '').trim().toLowerCase();
  if (!email) return null;
  // r.fields is arbitrary per-recipient CSV data (e.g. { website_name, industry })
  // — stored as one JSON blob (see lib/schema.sql's own comment on the column)
  // so a new merge field never needs a schema change.
  const fieldsJson = r.fields && Object.keys(r.fields).length ? JSON.stringify(r.fields) : null;

  if (driver === 'postgres') {
    const rows = await sql`
      INSERT INTO recipients (email, first_name, full_name, salutation_confidence, fields)
      VALUES (${email}, ${r.first || null}, ${r.full || null}, ${r.confidence || null}, ${fieldsJson})
      ON CONFLICT (email) DO UPDATE
        SET first_name = COALESCE(EXCLUDED.first_name, recipients.first_name),
            full_name  = COALESCE(EXCLUDED.full_name,  recipients.full_name),
            fields     = COALESCE(EXCLUDED.fields,     recipients.fields)
      RETURNING id`;
    return rows[0].id;
  }
  if (driver === 'sqlite') {
    db.prepare(`INSERT INTO recipients (email, first_name, full_name, salutation_confidence, fields)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(email) DO UPDATE SET
                  first_name = COALESCE(excluded.first_name, recipients.first_name),
                  full_name  = COALESCE(excluded.full_name,  recipients.full_name),
                  fields     = COALESCE(excluded.fields,     recipients.fields)`)
      .run(email, r.first || null, r.full || null, r.confidence || null, fieldsJson);
    return db.prepare('SELECT id FROM recipients WHERE email = ?').get(email).id;
  }
  return null;
}

/**
 * Addresses that must not be contacted, and addresses already delivered to.
 *
 * Deliberately returns bare strings and nothing else: the browser needs a set
 * of addresses to filter its list, and shipping full log rows (which carry the
 * stored HTML body) to answer that question moved megabytes per campaign.
 *
 * `blocked`/`replied`/`bounced` are global on purpose — do_not_contact lives
 * on the person (recipients has no from_email column), so a reply to ANY
 * account suppresses them everywhere. `sent`, when an owner is given, is
 * scoped to THAT account's own sends — recipients.last_sent_at is global
 * across every account, so without this an owner would see someone as
 * already-sent the moment any other account mailed them, despite never
 * having contacted that person itself.
 */
async function suppression(owner) {
  await init();
  const out = { sent: [], blocked: [], replied: [], bounced: [] };
  if (driver === 'none') return out;
  const who = owner ? String(owner).trim().toLowerCase() : '';

  if (driver === 'postgres') {
    const rows = await sql`
      SELECT email, status, do_not_contact, last_sent_at FROM recipients
      WHERE last_sent_at IS NOT NULL OR do_not_contact = TRUE`;
    for (const r of rows) {
      if (r.last_sent_at && !who) out.sent.push(r.email);
      if (r.do_not_contact) out.blocked.push(r.email);
      if (r.status === 'replied') out.replied.push(r.email);
      if (r.status === 'bounced') out.bounced.push(r.email);
    }
    if (who) {
      const sent = await sql`SELECT DISTINCT recipient FROM sends WHERE sender = ${who} AND status = 'sent'`;
      out.sent = sent.map(s => s.recipient);
    }
    return out;
  }
  const rows = db.prepare(`SELECT email, status, do_not_contact, last_sent_at FROM recipients
                           WHERE last_sent_at IS NOT NULL OR do_not_contact = 1`).all();
  for (const r of rows) {
    if (r.last_sent_at && !who) out.sent.push(r.email);
    if (r.do_not_contact) out.blocked.push(r.email);
    if (r.status === 'replied') out.replied.push(r.email);
    if (r.status === 'bounced') out.bounced.push(r.email);
  }
  if (who) {
    out.sent = db.prepare(`SELECT DISTINCT recipient FROM sends WHERE sender = ? AND status = 'sent'`)
      .all(who).map(s => s.recipient);
  }
  return out;
}

/* ---------- campaigns ---------- */

async function startCampaign(c) {
  await init();
  if (driver === 'postgres') {
    const rows = await sql`
      INSERT INTO campaigns (name, subject_template, from_email, total_count, status,
                             parent_id, followup_round, imported, import_source, started_at, group_key)
      VALUES (${c.name || null}, ${c.subject || null}, ${String(c.from || '').toLowerCase()},
              ${c.total || 0}, 'running', ${c.parentId || null}, ${Number(c.followupRound || 0)},
              ${!!c.imported}, ${c.importSource || null},
              ${c.startedAt || new Date().toISOString()}, ${c.groupKey || null})
      RETURNING id`;
    return rows[0].id;
  }
  if (driver === 'sqlite') {
    const info = db.prepare(`INSERT INTO campaigns (name, subject_template, from_email, total_count,
                                                    status, started_at, parent_id, followup_round,
                                                    imported, import_source, group_key)
                             VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?)`)
      .run(c.name || null, c.subject || null, String(c.from || '').toLowerCase(),
           c.total || 0, c.startedAt || new Date().toISOString(),
           c.parentId || null, Number(c.followupRound || 0),
           c.imported ? 1 : 0, c.importSource || null, c.groupKey || null);
    return Number(info.lastInsertRowid);
  }
  return null;
}

async function finishCampaign(id, status) {
  await init();
  if (!id) return false;
  const st = status === 'stopped' ? 'stopped' : 'done';
  if (driver === 'postgres') {
    await sql`UPDATE campaigns SET status = ${st}, finished_at = now() WHERE id = ${id}`;
    return true;
  }
  if (driver === 'sqlite') {
    db.prepare('UPDATE campaigns SET status = ?, finished_at = ? WHERE id = ?')
      .run(st, new Date().toISOString(), id);
    return true;
  }
  return false;
}

/** Campaign history for one Gmail account, newest first, with live counts. */
async function campaigns(owner, limit) {
  await init();
  const n = Math.min(Number(limit) || 100, 500);
  const who = String(owner || '').toLowerCase();
  if (driver === 'none') return [];

  if (driver === 'postgres') {
    const rows = who
      ? await sql`SELECT id, name, subject_template, from_email, started_at, finished_at, status,
                         sent_count, failed_count, total_count, parent_id, followup_round, imported, import_source, group_key
                  FROM campaigns WHERE from_email = ${who} ORDER BY started_at DESC LIMIT ${n}`
      : await sql`SELECT id, name, subject_template, from_email, started_at, finished_at, status,
                         sent_count, failed_count, total_count, parent_id, followup_round, imported, import_source, group_key
                  FROM campaigns ORDER BY started_at DESC LIMIT ${n}`;
    return rows.map(campaignRow);
  }
  const rows = who
    ? db.prepare(`SELECT * FROM campaigns WHERE from_email = ? ORDER BY started_at DESC LIMIT ?`).all(who, n)
    : db.prepare(`SELECT * FROM campaigns ORDER BY started_at DESC LIMIT ?`).all(n);
  return rows.map(campaignRow);
}

/* Gmail's own cap (500 recipients/24h on a personal account, 2000 on
   Workspace — enforced by Google, not by this app) is a rolling window, not a
   midnight reset, so this counts sends in the last 24 hours rather than
   "since local midnight." Surfaced per account so several accounts sending
   concurrently each show their own remaining capacity instead of the first
   sign of trouble being a mid-campaign SEND_QUOTA_EXCEEDED. */
async function sentToday(fromEmail, opts) {
  await init();
  const who = String(fromEmail || '').trim().toLowerCase();
  const limit = (opts && opts.limit) || 500;
  if (driver === 'none' || !who) return { sent: 0, limit };

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  if (driver === 'postgres') {
    const rows = await sql`SELECT COUNT(*) AS n FROM sends WHERE sender = ${who} AND time >= ${since} AND status = 'sent'`;
    return { sent: Number(rows[0].n || 0), limit };
  }
  const row = db.prepare(`SELECT COUNT(*) AS n FROM sends WHERE sender = ? AND time >= ? AND status = 'sent'`).get(who, since);
  return { sent: Number(row.n || 0), limit };
}

const campaignRow = c => ({
  id: c.id,
  parentId: c.parent_id || null,
  followupRound: Number(c.followup_round || 0),
  groupKey: c.group_key || null,
  imported: !!c.imported,
  importSource: c.import_source || null,
  name: c.name || '(untitled)',
  subject: c.subject_template || '',
  from: c.from_email || '',
  startedAt: c.started_at instanceof Date ? c.started_at.toISOString() : c.started_at,
  finishedAt: c.finished_at instanceof Date ? c.finished_at.toISOString() : c.finished_at,
  status: c.status,
  sent: Number(c.sent_count || 0),
  failed: Number(c.failed_count || 0),
  total: Number(c.total_count || 0),
});

/* ---------- sends ---------- */

/* The two drivers word the same violation differently:
     postgres -> 'duplicate key value violates unique constraint "idx_sends_campaign_recipient"'
     sqlite   -> 'UNIQUE constraint failed: sends.campaign_id, sends.recipient_id'
   Both mean the same thing: this person already has a send row in this
   campaign, so the attempt is a duplicate rather than an error. */
function isDuplicateSend(err) {
  const m = String(err && err.message || '');
  return m.includes('idx_sends_campaign_recipient')
      || (m.includes('UNIQUE constraint failed') && m.includes('sends.campaign_id'));
}

/**
 * Claim the (campaign_id, recipient_id) slot BEFORE dialing SMTP, so a
 * retried request or a second tab can never send the same person twice.
 *
 * insert() used to be the only guard, but it ran AFTER nodemailer's
 * sendMail() — the UNIQUE index stopped a second DATABASE ROW, not a second
 * EMAIL, so a genuine duplicate request still reached Gmail and mailed the
 * person again. Reserving the row up front, with status 'sending', means a
 * duplicate is caught before any SMTP call happens. api/send.js calls this
 * first, only proceeds to sendMail() if it gets a real id back, and then
 * calls finalizeSend() to fill in what actually happened.
 *
 * Also the ONE place every live send passes through regardless of campaign —
 * so this is where do_not_contact is enforced, not just inside
 * followupCandidates(). Without this, only a follow-up refused to re-mail
 * someone who replied; a brand-new campaign with that same address pasted
 * in again had nothing stopping it, which contradicts the guarantee
 * README.md states ("refuses to email them again"). insert() (used only by
 * api/import.js, recording real history that already happened) is
 * deliberately NOT gated by this — you cannot retroactively un-send an
 * email that was actually delivered before this tool ever saw it.
 */
async function reserveSend(e) {
  await init();
  if (driver === 'none') return null;

  const recipientId = await upsertRecipient({
    email: e.to, first: e.name, full: e.fullName, confidence: e.confidence, fields: e.fields,
  });

  if (recipientId) {
    const blocked = driver === 'postgres'
      ? (await sql`SELECT do_not_contact FROM recipients WHERE id = ${recipientId}`)[0]
      : db.prepare('SELECT do_not_contact FROM recipients WHERE id = ?').get(recipientId);
    if (blocked && (blocked.do_not_contact === true || blocked.do_not_contact === 1)) {
      return 'suppressed';
    }
  }

  const round = Number(e.followupRound || 0);

  if (driver === 'postgres') {
    try {
      const rows = await sql`INSERT INTO sends (campaign_id, recipient_id, time, sender, recipient, name, subject,
                                   attachments, status, followup_round, in_reply_to_send, imported)
                VALUES (${e.campaignId || null}, ${recipientId}, ${e.time}, ${e.from || ''}, ${e.to || ''},
                        ${e.name || ''}, ${e.subject || ''}, ${JSON.stringify(e.attachments || [])},
                        'sending', ${round}, ${e.inReplyToSend || null}, ${!!e.imported})
                RETURNING id`;
      return { id: rows[0].id, recipientId };
    } catch (err) {
      if (isDuplicateSend(err)) return 'duplicate';
      throw err;
    }
  }
  try {
    const info = db.prepare(`INSERT INTO sends (campaign_id, recipient_id, time, sender, recipient, name, subject,
                                   attachments, status, followup_round, in_reply_to_send, imported)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sending', ?, ?, ?)`)
      .run(e.campaignId || null, recipientId, e.time, e.from || '', e.to || '', e.name || '',
           e.subject || '', JSON.stringify(e.attachments || []), round, e.inReplyToSend || null, e.imported ? 1 : 0);
    return { id: Number(info.lastInsertRowid), recipientId };
  } catch (err) {
    if (isDuplicateSend(err)) return 'duplicate';
    throw err;
  }
}

/**
 * Fill in what actually happened to a row reserveSend() already created —
 * whether Gmail accepted it, its Message-Id, and the recipient/campaign
 * counters. Never throws a duplicate: the slot is already this call's own,
 * reserved a moment ago, so there is nothing left to collide with.
 */
async function finalizeSend(sendId, recipientId, e) {
  await init();
  if (driver === 'none' || !sendId) return false;

  const delivered = e.status === 'sent';
  const round = Number(e.followupRound || 0);
  const referencesJson = e.references && e.references.length ? JSON.stringify(e.references) : null;

  if (driver === 'postgres') {
    await sql`UPDATE sends SET status = ${e.status || ''}, error = ${e.error || null},
                body = ${e.body || ''}, message_id = ${e.messageId || null},
                references_json = ${referencesJson}
              WHERE id = ${sendId}`;
    if (delivered && recipientId) {
      await sql`UPDATE recipients
                SET last_sent_at   = ${e.time},
                    contact_count  = contact_count + 1,
                    followup_count = followup_count + ${round > 0 ? 1 : 0},
                    last_followup_at = ${round > 0 ? e.time : null},
                    status = CASE WHEN status = 'new' THEN 'sent' ELSE status END
                WHERE id = ${recipientId}`;
    }
    if (e.campaignId) {
      await sql`UPDATE campaigns
                SET sent_count   = sent_count   + ${delivered ? 1 : 0},
                    failed_count = failed_count + ${delivered ? 0 : 1}
                WHERE id = ${e.campaignId}`;
    }
    return true;
  }

  db.prepare(`UPDATE sends SET status = ?, error = ?, body = ?, message_id = ?, references_json = ? WHERE id = ?`)
    .run(e.status || '', e.error || null, e.body || '', e.messageId || null, referencesJson, sendId);
  if (delivered && recipientId) {
    db.prepare(`UPDATE recipients
                SET last_sent_at     = ?,
                    contact_count    = contact_count + 1,
                    followup_count   = followup_count + ?,
                    last_followup_at = COALESCE(?, last_followup_at),
                    status = CASE WHEN status = 'new' THEN 'sent' ELSE status END
                WHERE id = ?`)
      .run(e.time, round > 0 ? 1 : 0, round > 0 ? e.time : null, recipientId);
  }
  if (e.campaignId) {
    db.prepare(`UPDATE campaigns SET sent_count = sent_count + ?, failed_count = failed_count + ? WHERE id = ?`)
      .run(delivered ? 1 : 0, delivered ? 0 : 1, e.campaignId);
  }
  return true;
}

/**
 * Record one delivery attempt and roll the campaign counters forward in the
 * same call, so the history stays correct even if the browser tab dies
 * mid-campaign.
 *
 * A duplicate (campaign_id, recipient_id) is rejected by a UNIQUE index rather
 * than overwritten: that is the guard against a retried request or a second
 * tab sending the same person twice. It is reported, not thrown.
 *
 * Used by api/import.js, which already knows the outcome (a message that was
 * really delivered, read back from the Sent folder) before it ever calls
 * this — there is no SMTP call to race, so the reserve/finalize split above
 * doesn't apply here.
 */
async function insert(e) {
  await init();
  if (driver === 'none') return false;

  const recipientId = await upsertRecipient({
    email: e.to, first: e.name, full: e.fullName, confidence: e.confidence, fields: e.fields,
  });
  const delivered = e.status === 'sent';
  /* 0 is the original send; 1+ is a follow-up round. Stored rather than
     inferred from dates, so the trail can say which message was answered. */
  const round = Number(e.followupRound || 0);
  /* RFC 5322 3.6.4: References must carry the WHOLE ancestor chain, not just
     the immediate parent's Message-Id — the caller (followupCandidates) is
     responsible for accumulating it; this just persists whatever it built. */
  const referencesJson = e.references && e.references.length ? JSON.stringify(e.references) : null;

  if (driver === 'postgres') {
    let insertedId = null;
    try {
      const rows = await sql`INSERT INTO sends (campaign_id, recipient_id, time, sender, recipient, name, subject,
                                   attachments, status, error, body, message_id,
                                   followup_round, in_reply_to_send, imported, references_json)
                VALUES (${e.campaignId || null}, ${recipientId}, ${e.time}, ${e.from || ''}, ${e.to || ''},
                        ${e.name || ''}, ${e.subject || ''}, ${JSON.stringify(e.attachments || [])},
                        ${e.status || ''}, ${e.error || null}, ${e.body || ''}, ${e.messageId || null},
                        ${round}, ${e.inReplyToSend || null}, ${!!e.imported}, ${referencesJson})
                RETURNING id`;
      insertedId = rows[0] && rows[0].id;
    } catch (err) {
      if (isDuplicateSend(err)) return 'duplicate';
      throw err;
    }
    if (delivered && recipientId) {
      /* contact_count is every time we mailed them; followup_count only the
         chases. Both live on the person so a cap like "never chase more than
         three times" holds across campaigns. */
      await sql`UPDATE recipients
                SET last_sent_at   = ${e.time},
                    contact_count  = contact_count + 1,
                    followup_count = followup_count + ${round > 0 ? 1 : 0},
                    last_followup_at = ${round > 0 ? e.time : null},
                    status = CASE WHEN status = 'new' THEN 'sent' ELSE status END
                WHERE id = ${recipientId}`;
    }
    if (e.campaignId) {
      await sql`UPDATE campaigns
                SET sent_count   = sent_count   + ${delivered ? 1 : 0},
                    failed_count = failed_count + ${delivered ? 0 : 1}
                WHERE id = ${e.campaignId}`;
    }
    /* Most callers just need to know it worked (see the existing
       `assert.strictEqual(r, true)` tests) — the inserted id is only
       returned in the shape {id} when the caller opts in, so their
       contract doesn't change. api/import.js's commit() needs the id to
       link a follow-up round onto the DB row for the message it answers,
       not just its Sent-folder uid. */
    return e.returnId ? { id: insertedId } : true;
  }

  let info;
  try {
    info = db.prepare(`INSERT INTO sends (campaign_id, recipient_id, time, sender, recipient, name, subject,
                                   attachments, status, error, body, message_id,
                                   followup_round, in_reply_to_send, imported, references_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(e.campaignId || null, recipientId, e.time, e.from || '', e.to || '', e.name || '',
           e.subject || '', JSON.stringify(e.attachments || []), e.status || '',
           e.error || null, e.body || '', e.messageId || null,
           round, e.inReplyToSend || null, e.imported ? 1 : 0, referencesJson);
  } catch (err) {
    if (isDuplicateSend(err)) return 'duplicate';
    throw err;
  }
  if (delivered && recipientId) {
    db.prepare(`UPDATE recipients
                SET last_sent_at     = ?,
                    contact_count    = contact_count + 1,
                    followup_count   = followup_count + ?,
                    last_followup_at = COALESCE(?, last_followup_at),
                    status = CASE WHEN status = 'new' THEN 'sent' ELSE status END
                WHERE id = ?`)
      .run(e.time, round > 0 ? 1 : 0, round > 0 ? e.time : null, recipientId);
  }
  if (e.campaignId) {
    db.prepare(`UPDATE campaigns SET sent_count = sent_count + ?, failed_count = failed_count + ? WHERE id = ?`)
      .run(delivered ? 1 : 0, delivered ? 0 : 1, e.campaignId);
  }
  return e.returnId ? { id: Number(info.lastInsertRowid) } : true;
}

/**
 * Log rows WITHOUT the stored body. The body is often several KB of HTML and
 * is only ever read one row at a time by the "View" button, so it is fetched
 * on demand by body() instead of shipped with every list.
 */
async function list(limit, opts) {
  await init();
  const n = Math.min(Number(limit) || 1000, 5000);
  const o = opts || {};
  const who = o.owner ? String(o.owner).toLowerCase() : '';
  if (driver === 'none') return [];

  if (driver === 'postgres') {
    let rows;
    if (o.campaignId) {
      rows = await sql`SELECT id, campaign_id, time, sender, recipient, name, subject, attachments,
                              status, error, message_id
                       FROM sends WHERE campaign_id = ${o.campaignId} ORDER BY time DESC LIMIT ${n}`;
    } else if (who) {
      rows = await sql`SELECT id, campaign_id, time, sender, recipient, name, subject, attachments,
                              status, error, message_id
                       FROM sends WHERE sender = ${who} ORDER BY time DESC LIMIT ${n}`;
    } else {
      rows = await sql`SELECT id, campaign_id, time, sender, recipient, name, subject, attachments,
                              status, error, message_id
                       FROM sends ORDER BY time DESC LIMIT ${n}`;
    }
    return rows.map(ROW);
  }

  const cols = 'id, campaign_id, time, sender, recipient, name, subject, attachments, status, error, message_id';
  const rows = o.campaignId
    ? db.prepare(`SELECT ${cols} FROM sends WHERE campaign_id = ? ORDER BY id DESC LIMIT ?`).all(o.campaignId, n)
    : who
      ? db.prepare(`SELECT ${cols} FROM sends WHERE sender = ? ORDER BY id DESC LIMIT ?`).all(who, n)
      : db.prepare(`SELECT ${cols} FROM sends ORDER BY id DESC LIMIT ?`).all(n);
  return rows.map(ROW);
}

/** The exact HTML one recipient received. Fetched only when View is clicked. */
async function body(id) {
  await init();
  if (driver === 'postgres') {
    const rows = await sql`SELECT body FROM sends WHERE id = ${id}`;
    return rows.length ? rows[0].body : null;
  }
  if (driver === 'sqlite') {
    const r = db.prepare('SELECT body FROM sends WHERE id = ?').get(id);
    return r ? r.body : null;
  }
  return null;
}

/**
 * Everyone in one campaign, with the state of their conversation.
 *
 * One row per person, because a campaign is read person-by-person: did they
 * get it, did they answer, and how many times have we chased them since.
 */
async function campaignPeople(campaignId) {
  await init();
  if (driver === 'none' || !campaignId) return [];

  if (driver === 'postgres') {
    const rows = await sql`
      SELECT r.id, r.email, r.first_name, r.full_name, r.status,
             r.do_not_contact, r.followup_count, r.contact_count,
             r.replied_at, r.ooo_until, r.bounce_count,
             s.time AS first_time, s.status AS first_status, s.error AS first_error,
             (SELECT COUNT(*) FROM sends x
               WHERE x.recipient_id = r.id AND x.campaign_id = ${campaignId}) AS send_count,
             (SELECT COUNT(*) FROM replies p WHERE p.recipient_id = r.id) AS reply_count,
             (SELECT MAX(p.received_at) FROM replies p WHERE p.recipient_id = r.id) AS last_reply
      FROM recipients r
      JOIN sends s ON s.recipient_id = r.id AND s.campaign_id = ${campaignId}
                  AND s.followup_round = 0
      ORDER BY s.time ASC`;
    return rows.map(personRow);
  }

  const rows = db.prepare(`
    SELECT r.id, r.email, r.first_name, r.full_name, r.status,
           r.do_not_contact, r.followup_count, r.contact_count,
           r.replied_at, r.ooo_until, r.bounce_count,
           s.time AS first_time, s.status AS first_status, s.error AS first_error,
           (SELECT COUNT(*) FROM sends x WHERE x.recipient_id = r.id AND x.campaign_id = ?) AS send_count,
           (SELECT COUNT(*) FROM replies p WHERE p.recipient_id = r.id) AS reply_count,
           (SELECT MAX(p.received_at) FROM replies p WHERE p.recipient_id = r.id) AS last_reply
    FROM recipients r
    JOIN sends s ON s.recipient_id = r.id AND s.campaign_id = ? AND s.followup_round = 0
    ORDER BY s.time ASC`).all(campaignId, campaignId);
  return rows.map(personRow);
}

const iso = t => (t instanceof Date ? t.toISOString() : t) || null;

const personRow = p => ({
  id: p.id,
  email: p.email,
  name: p.first_name || '',
  fullName: p.full_name || '',
  status: p.status,
  doNotContact: !!p.do_not_contact,
  followups: Number(p.followup_count || 0),
  contacts: Number(p.contact_count || 0),
  sends: Number(p.send_count || 0),
  replies: Number(p.reply_count || 0),
  firstSentAt: iso(p.first_time),
  firstStatus: p.first_status,
  firstError: p.first_error || null,
  repliedAt: iso(p.replied_at),
  lastReplyAt: iso(p.last_reply),
  oooUntil: iso(p.ooo_until),
  bounces: Number(p.bounce_count || 0),
});

/**
 * The whole conversation with one person, oldest first:
 *
 *   initial -> follow-up 1 -> reply -> follow-up 2 -> out-of-office ...
 *
 * Sends and replies are merged into a single ordered trail because that is how
 * the exchange actually happened. Each reply carries `repliesTo`, the round it
 * landed on, so answering the 2nd follow-up rather than the first is visible
 * instead of inferred.
 */
async function thread(recipientId) {
  await init();
  if (driver === 'none' || !recipientId) return [];
  let sends, replies;

  if (driver === 'postgres') {
    sends = await sql`
      SELECT id, campaign_id, time, subject, status, error, message_id, followup_round, attachments
      FROM sends WHERE recipient_id = ${recipientId} ORDER BY time ASC`;
    replies = await sql`
      SELECT p.id, p.received_at, p.from_email, p.subject, p.snippet, p.kind,
             p.in_reply_to, p.send_id, s.followup_round AS answered_round
      FROM replies p LEFT JOIN sends s ON s.id = p.send_id
      WHERE p.recipient_id = ${recipientId} ORDER BY p.received_at ASC`;
  } else {
    sends = db.prepare(`SELECT id, campaign_id, time, subject, status, error, message_id,
                               followup_round, attachments
                        FROM sends WHERE recipient_id = ? ORDER BY time ASC`).all(recipientId);
    replies = db.prepare(`SELECT p.id, p.received_at, p.from_email, p.subject, p.snippet, p.kind,
                                 p.in_reply_to, p.send_id, s.followup_round AS answered_round
                          FROM replies p LEFT JOIN sends s ON s.id = p.send_id
                          WHERE p.recipient_id = ? ORDER BY p.received_at ASC`).all(recipientId);
  }

  const trail = [];
  for (const s of sends) {
    trail.push({
      type: 'sent',
      id: s.id,
      at: iso(s.time),
      round: Number(s.followup_round || 0),
      label: Number(s.followup_round || 0) === 0 ? 'Initial email' : 'Follow-up ' + s.followup_round,
      subject: s.subject || '',
      status: s.status,
      error: s.error || null,
      messageId: s.message_id || null,
      attachments: typeof s.attachments === 'string'
        ? JSON.parse(s.attachments || '[]') : (s.attachments || []),
    });
  }
  for (const r of replies) {
    const round = r.answered_round == null ? null : Number(r.answered_round);
    trail.push({
      type: 'received',
      id: r.id,
      at: iso(r.received_at),
      kind: r.kind,
      /* Which message they actually answered. Null when the reply could not be
         threaded — it still belongs to the person, just not to a known round. */
      repliesTo: round,
      label: round == null ? 'Reply' : (round === 0 ? 'Replied to the initial email'
                                                    : 'Replied to follow-up ' + round),
      from: r.from_email || '',
      subject: r.subject || '',
      snippet: r.snippet || '',
    });
  }
  trail.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return trail;
}

/**
 * Record one classified inbound message and apply what it means.
 *
 * Matching runs strongest-signal-first:
 *   1. In-Reply-To / References against a stored message_id — survives
 *      forwarding and address aliases, so it is authoritative.
 *   2. The From address — used only when no header resolves, because a reply
 *      can legitimately arrive from a colleague or an alias.
 * An unmatched message is still stored: it belongs to the mailbox even if it
 * cannot be tied to a campaign.
 *
 * The consequences are deliberately asymmetric:
 *   reply / unsubscribe / hard bounce  -> do_not_contact, permanently
 *   out of office                      -> ooo_until, a RETRY LATER, not a block
 *   soft bounce                        -> a strike; blocked on the third
 * Treating an out-of-office as a permanent suppression would quietly lose a
 * live contact, which is the costlier mistake.
 */
async function recordReply(m) {
  await init();
  if (driver === 'none' || !m) return { matched: false, stored: false };

  const ids = (m.references && m.references.length)
    ? m.references
    : (m.inReplyTo ? [m.inReplyTo] : []);

  let sendId = null;
  let recipientId = null;

  if (ids.length) {
    if (driver === 'postgres') {
      const rows = await sql`SELECT id, recipient_id FROM sends
                             WHERE message_id = ANY(${ids}) ORDER BY time DESC LIMIT 1`;
      if (rows.length) { sendId = rows[0].id; recipientId = rows[0].recipient_id; }
    } else {
      const marks = ids.map(() => '?').join(',');
      const row = db.prepare(`SELECT id, recipient_id FROM sends
                              WHERE message_id IN (${marks}) ORDER BY time DESC LIMIT 1`).get(...ids);
      if (row) { sendId = row.id; recipientId = row.recipient_id; }
    }
  }

  /* Fall back to the address only when the headers gave us nothing, and only
     for someone we have actually mailed — otherwise every newsletter in the
     inbox would attach itself to a contact. */
  if (!recipientId && m.from) {
    const email = String(m.from).toLowerCase();
    if (driver === 'postgres') {
      const rows = await sql`SELECT id FROM recipients
                             WHERE email = ${email} AND last_sent_at IS NOT NULL`;
      if (rows.length) recipientId = rows[0].id;
    } else {
      const row = db.prepare('SELECT id FROM recipients WHERE email = ? AND last_sent_at IS NOT NULL').get(email);
      if (row) recipientId = row.id;
    }
  }

  const kind = m.kind || 'reply';
  const mailbox = m.mailbox || 'INBOX';

  /* Re-scanning the same mailbox must not create the message twice: the UNIQUE
     index on (mailbox, imap_uid) makes the insert idempotent. */
  let stored = true;
  try {
    if (driver === 'postgres') {
      await sql`INSERT INTO replies (recipient_id, send_id, received_at, from_email, subject,
                                     snippet, kind, in_reply_to, mailbox, imap_uid)
                VALUES (${recipientId}, ${sendId}, ${m.receivedAt}, ${m.from || ''}, ${m.subject || ''},
                        ${m.snippet || ''}, ${kind}, ${m.inReplyTo || null}, ${mailbox}, ${m.uid || null})
                ON CONFLICT DO NOTHING`;
    } else {
      db.prepare(`INSERT OR IGNORE INTO replies (recipient_id, send_id, received_at, from_email, subject,
                                                 snippet, kind, in_reply_to, mailbox, imap_uid)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(recipientId, sendId, m.receivedAt, m.from || '', m.subject || '',
             m.snippet || '', kind, m.inReplyTo || null, mailbox, m.uid || null);
    }
  } catch (e) {
    stored = false;
  }

  if (recipientId) await applyVerdict(recipientId, kind, m);
  return { matched: !!recipientId, stored, sendId, recipientId };
}

/* Turn a classification into lifetime state on the person. */
async function applyVerdict(recipientId, kind, m) {
  const at = m.receivedAt;

  if (kind === 'reply') {
    if (driver === 'postgres') {
      await sql`UPDATE recipients SET status = 'replied', replied_at = ${at},
                  do_not_contact = TRUE WHERE id = ${recipientId}`;
    } else {
      db.prepare(`UPDATE recipients SET status='replied', replied_at=?, do_not_contact=1 WHERE id=?`)
        .run(at, recipientId);
    }
    return;
  }

  if (kind === 'unsubscribe') {
    if (driver === 'postgres') {
      await sql`UPDATE recipients SET status = 'unsubscribed', do_not_contact = TRUE WHERE id = ${recipientId}`;
    } else {
      db.prepare(`UPDATE recipients SET status='unsubscribed', do_not_contact=1 WHERE id=?`).run(recipientId);
    }
    return;
  }

  if (kind === 'ooo') {
    /* Not a suppression. ooo_until says when they are worth trying again;
       leaving do_not_contact alone keeps them in future follow-ups. */
    if (driver === 'postgres') {
      await sql`UPDATE recipients SET status = 'ooo', ooo_until = ${m.oooUntil || null}
                WHERE id = ${recipientId} AND do_not_contact = FALSE`;
    } else {
      db.prepare(`UPDATE recipients SET status='ooo', ooo_until=? WHERE id=? AND do_not_contact=0`)
        .run(m.oooUntil || null, recipientId);
    }
    return;
  }

  if (kind === 'bounce') {
    if (m.hard) {
      if (driver === 'postgres') {
        await sql`UPDATE recipients SET status = 'bounced', do_not_contact = TRUE,
                    bounce_count = bounce_count + 1 WHERE id = ${recipientId}`;
      } else {
        db.prepare(`UPDATE recipients SET status='bounced', do_not_contact=1,
                    bounce_count=bounce_count+1 WHERE id=?`).run(recipientId);
      }
      return;
    }
    /* Soft bounce: a full mailbox usually clears, so count strikes and only
       suppress once it is clearly not temporary. */
    if (driver === 'postgres') {
      await sql`UPDATE recipients SET bounce_count = bounce_count + 1,
                  status = CASE WHEN bounce_count + 1 >= 3 THEN 'bounced' ELSE status END,
                  do_not_contact = (bounce_count + 1 >= 3)
                WHERE id = ${recipientId}`;
    } else {
      db.prepare(`UPDATE recipients SET bounce_count = bounce_count + 1,
                    status = CASE WHEN bounce_count + 1 >= 3 THEN 'bounced' ELSE status END,
                    do_not_contact = CASE WHEN bounce_count + 1 >= 3 THEN 1 ELSE do_not_contact END
                  WHERE id = ?`).run(recipientId);
    }
  }
}

/**
 * Everyone a follow-up could go to, with the reason each is eligible.
 *
 * Anyone suppressed is excluded here rather than filtered in the browser, so a
 * stale page cannot mail someone who has already replied.
 */
async function followupCandidates(campaignId, opts) {
  await init();
  if (driver === 'none' || !campaignId) return [];
  const o = opts || {};
  const cap = o.cap === false ? 999 : Number(o.maxFollowups || 3);
  const now = new Date().toISOString();

  const rows = driver === 'postgres'
    ? await sql`
        SELECT r.id, r.email, r.first_name, r.full_name, r.status, r.followup_count,
               r.ooo_until, r.bounce_count,
               s.id AS send_id, s.message_id, s.subject, s.status AS send_status, s.time,
               s.references_json
        FROM recipients r
        JOIN sends s ON s.recipient_id = r.id AND s.campaign_id = ${campaignId}
        WHERE r.do_not_contact = FALSE
          AND r.followup_count < ${cap}
          AND (r.ooo_until IS NULL OR r.ooo_until <= ${now})
        ORDER BY s.time ASC`
    : db.prepare(`
        SELECT r.id, r.email, r.first_name, r.full_name, r.status, r.followup_count,
               r.ooo_until, r.bounce_count,
               s.id AS send_id, s.message_id, s.subject, s.status AS send_status, s.time,
               s.references_json
        FROM recipients r
        JOIN sends s ON s.recipient_id = r.id AND s.campaign_id = ?
        WHERE r.do_not_contact = 0
          AND r.followup_count < ?
          AND (r.ooo_until IS NULL OR r.ooo_until <= ?)
        ORDER BY s.time ASC`).all(campaignId, cap, now);

  /* One row per person: a campaign can hold several sends for someone, and a
     follow-up threads onto the most recent delivered one. */
  const seen = new Map();
  for (const r of rows) {
    const why = r.send_status === 'sent' ? 'noreply' : 'failed';
    const prev = seen.get(r.email);
    if (prev && prev.why === 'noreply' && why === 'failed') continue;

    /* RFC 5322 3.6.4: this round's References = the send being answered's own
       References, plus that send's own Message-Id. Accumulating here (instead
       of sending only person.messageId as References, which was the bug) is
       what keeps the whole ancestor chain intact into round 3+. */
    let priorRefs = [];
    try { priorRefs = r.references_json ? JSON.parse(r.references_json) : []; } catch (e) { priorRefs = []; }
    const references = r.message_id ? [...priorRefs, r.message_id] : priorRefs;

    seen.set(r.email, {
      id: r.id,
      email: r.email,
      first: r.first_name || '',
      full: r.full_name || '',
      status: r.status,
      followups: Number(r.followup_count || 0),
      sendId: r.send_id,
      messageId: r.message_id || null,
      references,
      subject: r.subject || '',
      why: r.status === 'ooo' ? 'ooo' : (r.bounce_count > 0 ? 'soft' : why),
    });
  }
  return [...seen.values()];
}

/**
 * Who a stopped or interrupted campaign still owes an email to.
 *
 * The browser cannot be trusted to remember this: the send loop dies with the
 * tab, and a half-finished run leaves no client-side record of where it got
 * to. Rebuilding the remainder from the database is what makes resuming safe,
 * and the UNIQUE index on (campaign_id, recipient_id) is the backstop if the
 * same person is somehow submitted twice.
 */
async function campaignRemaining(campaignId) {
  await init();
  if (driver === 'none' || !campaignId) return { done: 0, remaining: [] };

  const rows = driver === 'postgres'
    ? await sql`SELECT r.email, r.first_name, r.full_name, r.salutation_confidence,
                       s.status
                FROM sends s JOIN recipients r ON r.id = s.recipient_id
                WHERE s.campaign_id = ${campaignId}`
    : db.prepare(`SELECT r.email, r.first_name, r.full_name, r.salutation_confidence, s.status
                  FROM sends s JOIN recipients r ON r.id = s.recipient_id
                  WHERE s.campaign_id = ?`).all(campaignId);

  const delivered = new Set();
  const failed = [];
  for (const r of rows) {
    if (r.status === 'sent') delivered.add(String(r.email).toLowerCase());
    else failed.push({
      email: r.email, first: r.first_name || '', full: r.full_name || '',
      confidence: r.salutation_confidence || null,
    });
  }
  /* Anyone delivered to is finished; anyone whose attempt failed is still
     owed one, and a failed row does not block a retry. */
  return {
    done: delivered.size,
    delivered: [...delivered],
    retry: failed.filter(f => !delivered.has(String(f.email).toLowerCase())),
  };
}

/**
 * Every Message-Id already stored.
 *
 * Used by the importer so a campaign cannot be imported twice: re-importing
 * would double every recipient's history and make the follow-up counts lie.
 */
async function knownMessageIds() {
  await init();
  if (driver === 'none') return [];
  if (driver === 'postgres') {
    const rows = await sql`SELECT message_id FROM sends WHERE message_id IS NOT NULL`;
    return rows.map(r => r.message_id);
  }
  return db.prepare('SELECT message_id FROM sends WHERE message_id IS NOT NULL')
    .all().map(r => r.message_id);
}

async function clear() {
  await init();
  if (driver === 'postgres') {
    await sql`DELETE FROM replies`;
    await sql`DELETE FROM sends`;
    await sql`DELETE FROM campaigns`;
    await sql`UPDATE recipients SET last_sent_at = NULL, status = 'new'`;
    return true;
  }
  if (driver === 'sqlite') {
    db.exec('DELETE FROM replies');
    db.exec('DELETE FROM sends');
    db.exec('DELETE FROM campaigns');
    db.exec("UPDATE recipients SET last_sent_at = NULL, status = 'new'");
    return true;
  }
  return false;
}

/* ---------- saved accounts ----------
   The app password is encrypted (lib/crypto.js) before it ever reaches a
   query, and decrypted only by loadAccount() — the one call the app makes
   right before opening an SMTP/IMAP connection. listAccounts() never touches
   the ciphertext at all, so a row can be proven to exist without ever
   decrypting it. */
const cryptoBox = require('./crypto');

async function saveAccount(a) {
  await init();
  if (driver === 'none') return false;
  const email = String(a.email || '').trim().toLowerCase();
  if (!email || !a.password) return false;
  const enc = cryptoBox.encrypt(a.password);

  if (driver === 'postgres') {
    await sql`
      INSERT INTO accounts (email, app_password_enc, from_name, reply_to, smtp_port, auto_scan_on_send, updated_at)
      VALUES (${email}, ${enc}, ${a.fromName || null}, ${a.replyTo || null}, ${a.smtpPort || '587'}, ${!!a.autoScanOnSend}, now())
      ON CONFLICT (email) DO UPDATE SET
        app_password_enc = EXCLUDED.app_password_enc,
        from_name         = EXCLUDED.from_name,
        reply_to          = EXCLUDED.reply_to,
        smtp_port         = EXCLUDED.smtp_port,
        auto_scan_on_send = EXCLUDED.auto_scan_on_send,
        updated_at        = now()`;
    return true;
  }
  db.prepare(`INSERT INTO accounts (email, app_password_enc, from_name, reply_to, smtp_port, auto_scan_on_send, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
              ON CONFLICT(email) DO UPDATE SET
                app_password_enc = excluded.app_password_enc,
                from_name = excluded.from_name,
                reply_to = excluded.reply_to,
                smtp_port = excluded.smtp_port,
                auto_scan_on_send = excluded.auto_scan_on_send,
                updated_at = datetime('now')`)
    .run(email, enc, a.fromName || null, a.replyTo || null, a.smtpPort || '587', a.autoScanOnSend ? 1 : 0);
  return true;
}

/** Every saved account's metadata, WITHOUT the password — used to render the list. */
async function listAccounts() {
  await init();
  if (driver === 'none') return [];
  if (driver === 'postgres') {
    const rows = await sql`SELECT email, from_name, reply_to, smtp_port, auto_scan_on_send
                           FROM accounts ORDER BY email`;
    return rows.map(accountRow);
  }
  const rows = db.prepare(`SELECT email, from_name, reply_to, smtp_port, auto_scan_on_send
                           FROM accounts ORDER BY email`).all();
  return rows.map(accountRow);
}

const accountRow = a => ({
  email: a.email,
  fromName: a.from_name || '',
  replyTo: a.reply_to || '',
  smtpPort: a.smtp_port || '587',
  autoScanOnSend: !!a.auto_scan_on_send,
});

/** One account WITH its decrypted password — only called right before an SMTP/IMAP connection. */
async function loadAccount(email) {
  await init();
  if (driver === 'none') return null;
  const who = String(email || '').trim().toLowerCase();
  if (!who) return null;
  const row = driver === 'postgres'
    ? (await sql`SELECT * FROM accounts WHERE email = ${who}`)[0]
    : db.prepare('SELECT * FROM accounts WHERE email = ?').get(who);
  if (!row) return null;
  return Object.assign(accountRow(row), { password: cryptoBox.decrypt(row.app_password_enc) });
}

async function deleteAccount(email) {
  await init();
  if (driver === 'none') return false;
  const who = String(email || '').trim().toLowerCase();
  if (!who) return false;
  if (driver === 'postgres') { await sql`DELETE FROM accounts WHERE email = ${who}`; return true; }
  db.prepare('DELETE FROM accounts WHERE email = ?').run(who);
  return true;
}

module.exports = {
  available, insert, reserveSend, finalizeSend, list, body, clear,
  upsertRecipient, suppression, campaignPeople, thread,
  recordReply, followupCandidates, campaignRemaining, knownMessageIds,
  startCampaign, finishCampaign, campaigns, sentToday,
  saveAccount, listAccounts, loadAccount, deleteAccount,
  reason: () => reason, driver: () => driver,
  _sql: () => sql, _db: () => db, _driver: () => driver, _init: init,
};
