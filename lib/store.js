'use strict';

/**
 * Optional SQLite archive of every send.
 *
 * Uses node:sqlite (built into Node 22.5+), so there is no native dependency
 * to compile and nothing to install. It only works where the filesystem is
 * writable — i.e. when you run the app locally. On Vercel the function
 * filesystem is read-only, so `available` stays false and the browser keeps
 * its own copy of the log in localStorage instead. Same UI either way.
 */

const path = require('path');
const fs = require('fs');

let db = null;
let reason = 'not initialised';

function init() {
  if (db || reason === 'disabled') return db;
  try {
    const { DatabaseSync } = require('node:sqlite');
    const dir = path.join(process.cwd(), 'data');
    fs.mkdirSync(dir, { recursive: true });
    db = new DatabaseSync(path.join(dir, 'mail.db'));
    db.exec(`CREATE TABLE IF NOT EXISTS sends (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      time TEXT NOT NULL,
      sender TEXT,
      recipient TEXT,
      name TEXT,
      subject TEXT,
      attachments TEXT,
      status TEXT,
      error TEXT
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_sends_time ON sends(time)');
    reason = 'ok';
  } catch (e) {
    db = null;
    reason = e.message;
  }
  return db;
}

const available = () => !!init();

function insert(e) {
  if (!init()) return false;
  db.prepare(`INSERT INTO sends (time, sender, recipient, name, subject, attachments, status, error)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(e.time, e.from || '', e.to || '', e.name || '', e.subject || '',
         JSON.stringify(e.attachments || []), e.status || '', e.error || '');
  return true;
}

function list(limit) {
  if (!init()) return [];
  return db.prepare('SELECT * FROM sends ORDER BY id DESC LIMIT ?')
    .all(Math.min(Number(limit) || 1000, 5000))
    .map(r => ({
      time: r.time, from: r.sender, to: r.recipient, name: r.name,
      subject: r.subject, attachments: JSON.parse(r.attachments || '[]'),
      status: r.status, error: r.error || null,
    }));
}

function clear() {
  if (!init()) return false;
  db.exec('DELETE FROM sends');
  return true;
}

module.exports = { available, insert, list, clear, reason: () => reason };
