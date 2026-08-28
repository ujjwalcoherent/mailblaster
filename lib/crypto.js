'use strict';

/**
 * Encrypt Gmail app passwords before they touch the database.
 *
 * AES-256-GCM: a random 12-byte IV per value (so two accounts with the same
 * password never produce the same ciphertext) plus a 16-byte auth tag (so a
 * tampered or corrupted row fails to decrypt loudly instead of returning
 * garbage that gets handed straight to nodemailer). The key comes from
 * ACCOUNTS_ENCRYPTION_KEY, a server-only env var never sent to the browser —
 * without it this whole feature is refused rather than falling back to
 * storing plaintext.
 */

const nodeCrypto = require('crypto');

function key() {
  const raw = process.env.ACCOUNTS_ENCRYPTION_KEY || '';
  if (!raw) return null;
  // Accept a 64-char hex string (32 bytes) or hash whatever else is given,
  // so a copy-pasted passphrase still works rather than throwing.
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  return nodeCrypto.createHash('sha256').update(raw).digest();
}

const available = () => !!key();

function encrypt(plaintext) {
  const k = key();
  if (!k) throw new Error('ACCOUNTS_ENCRYPTION_KEY is not set');
  const iv = nodeCrypto.randomBytes(12);
  const cipher = nodeCrypto.createCipheriv('aes-256-gcm', k, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // iv : tag : ciphertext, each base64, so it's one plain TEXT column.
  return iv.toString('base64') + ':' + tag.toString('base64') + ':' + enc.toString('base64');
}

function decrypt(stored) {
  const k = key();
  if (!k) throw new Error('ACCOUNTS_ENCRYPTION_KEY is not set');
  const [ivB64, tagB64, dataB64] = String(stored).split(':');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('malformed ciphertext');
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');
  const decipher = nodeCrypto.createDecipheriv('aes-256-gcm', k, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

module.exports = { available, encrypt, decrypt };
