'use strict';

/**
 * Send log, with three drivers picked automatically at runtime:
 *
 *   postgres  — used when POSTGRES_URL is set. This is the only driver that
 *               gives a shared, durable log on Vercel: every visitor and every
 *               device sees the same history.
 *   sqlite    — used locally, via node:sqlite (built into Node 22.5+, so
 *               nothing native to compile). Writes to ./data/mail.db.
 *   none      — read-only filesystem and no database configured. /api/log
 *               reports available:false and the browser falls back to its own
 *               localStorage copy, which is per-browser and not shared.
 *
 * Every function is async because the postgres driver is.
 */

const path = require('path');
const fs = require('fs');

let driver = null;      // 'postgres' | 'sqlite' | 'none'
let db = null;          // sqlite handle
let sql = null;         // postgres tagged template
let reason = 'not initialised';
let ready = null;       // in-flight init promise

const ROW = e => ({
  time: e.time,
  from: e.sender || e.from || '',
  to: e.recipient || e.to || '',
  name: e.name || '',
  subject: e.subject || '',
  attachments: typeof e.attachments === 'string' ? JSON.parse(e.attachments || '[]') : (e.attachments || []),
  status: e.status || '',
  error: e.error || null,
  body: e.body || '',
});

async function initPostgres() {
  const { sql: vsql } = require('@vercel/postgres');
  await vsql`CREATE TABLE IF NOT EXISTS sends (
    id BIGSERIAL PRIMARY KEY,
    time TIMESTAMPTZ NOT NULL,
    sender TEXT,
    recipient TEXT,
    name TEXT,
    subject TEXT,
    attachments JSONB,
    status TEXT,
    error TEXT,
    body TEXT
  )`;
  // migration for tables created before body was stored
  await vsql`ALTER TABLE sends ADD COLUMN IF NOT EXISTS body TEXT`;
  await vsql`CREATE INDEX IF NOT EXISTS idx_sends_time ON sends(time DESC)`;
  sql = vsql;
  driver = 'postgres';
  reason = 'postgres';
}

function initSqlite() {
  const { DatabaseSync } = require('node:sqlite');
  const dir = path.join(process.cwd(), 'data');
  fs.mkdirSync(dir, { recursive: true });
  const handle = new DatabaseSync(path.join(dir, 'mail.db'));
  handle.exec(`CREATE TABLE IF NOT EXISTS sends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    time TEXT NOT NULL,
    sender TEXT, recipient TEXT, name TEXT, subject TEXT,
    attachments TEXT, status TEXT, error TEXT, body TEXT
  )`);
  handle.exec('CREATE INDEX IF NOT EXISTS idx_sends_time ON sends(time)');
  // migration for databases created before body was stored
  const cols = handle.prepare('PRAGMA table_info(sends)').all().map(c => c.name);
  if (!cols.includes('body')) handle.exec('ALTER TABLE sends ADD COLUMN body TEXT');
  db = handle;
  driver = 'sqlite';
  reason = 'sqlite (data/mail.db)';
}

function init() {
  if (ready) return ready;
  ready = (async () => {
    if (process.env.POSTGRES_URL) {
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
      reason = process.env.POSTGRES_URL
        ? reason
        : 'no POSTGRES_URL set and the filesystem is read-only (' + e.code + '). '
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

async function insert(e) {
  await init();
  if (driver === 'postgres') {
    await sql`INSERT INTO sends (time, sender, recipient, name, subject, attachments, status, error, body)
              VALUES (${e.time}, ${e.from || ''}, ${e.to || ''}, ${e.name || ''}, ${e.subject || ''},
                      ${JSON.stringify(e.attachments || [])}, ${e.status || ''}, ${e.error || null},
                      ${e.body || ''})`;
    return true;
  }
  if (driver === 'sqlite') {
    db.prepare(`INSERT INTO sends (time, sender, recipient, name, subject, attachments, status, error, body)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(e.time, e.from || '', e.to || '', e.name || '', e.subject || '',
           JSON.stringify(e.attachments || []), e.status || '', e.error || '', e.body || '');
    return true;
  }
  return false;
}

async function list(limit) {
  await init();
  const n = Math.min(Number(limit) || 1000, 5000);
  if (driver === 'postgres') {
    const { rows } = await sql`SELECT time, sender, recipient, name, subject, attachments, status, error, body
                               FROM sends ORDER BY time DESC LIMIT ${n}`;
    return rows.map(r => ROW({
      time: r.time instanceof Date ? r.time.toISOString() : r.time,
      sender: r.sender, recipient: r.recipient, name: r.name, subject: r.subject,
      attachments: r.attachments, status: r.status, error: r.error, body: r.body,
    }));
  }
  if (driver === 'sqlite') {
    return db.prepare('SELECT * FROM sends ORDER BY id DESC LIMIT ?').all(n).map(ROW);
  }
  return [];
}

async function clear() {
  await init();
  if (driver === 'postgres') { await sql`DELETE FROM sends`; return true; }
  if (driver === 'sqlite') { db.exec('DELETE FROM sends'); return true; }
  return false;
}

module.exports = { available, insert, list, clear, reason: () => reason, driver: () => driver };
