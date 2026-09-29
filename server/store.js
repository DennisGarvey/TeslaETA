import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
export const hash = token => createHash('sha256').update(token).digest('hex');
const expiredLinkRetentionMs = 24 * 60 * 60 * 1000;
export class Store extends EventEmitter {
  constructor(path) {
    super(); this.setMaxListeners(0);
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    // Persist beside the database so Docker's data volume preserves recovery.
    if (path === ':memory:') this.key = randomBytes(32);
    else {
      const keyPath = `${path}.key`;
      try { writeFileSync(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      this.key = readFileSync(keyPath);
      if (this.key.length !== 32) throw new Error('Invalid sharing-link encryption key');
    }
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS shares (id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, car_id TEXT NOT NULL, label TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL)');
    this.db.exec('CREATE TABLE IF NOT EXISTS app_settings (name TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.db.exec('CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, encrypted_value TEXT NOT NULL)');
    this.db.exec('CREATE TABLE IF NOT EXISTS link_sequence (id INTEGER PRIMARY KEY CHECK (id = 1), next_number INTEGER NOT NULL)');
    this.pruneExpired();
    const labels = this.db.prepare('SELECT label FROM shares').all();
    const highest = labels.reduce((max, row) => Math.max(max, Number(/^Link (\d+)$/.exec(row.label)?.[1] || 0)), 0);
    this.db.prepare('INSERT OR IGNORE INTO link_sequence VALUES (1, ?)').run(highest + 1);
    if (!this.db.prepare('PRAGMA table_info(shares)').all().some(column => column.name === 'encrypted_token')) {
      this.db.exec('ALTER TABLE shares ADD COLUMN encrypted_token TEXT');
    }
  }
  sharingOrigin() { return this.db.prepare('SELECT value FROM app_settings WHERE name = ?').get('sharing_origin')?.value; }
  saveSharingOrigin(origin) { this.db.prepare('INSERT OR REPLACE INTO app_settings VALUES (?, ?)').run('sharing_origin', origin); }
  saveConnection(value) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from('mqtt-settings'));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    const encrypted = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
    this.db.prepare('INSERT OR REPLACE INTO settings VALUES (?, ?)').run('mqtt', encrypted);
  }
  loadConnection() {
    const row = this.db.prepare('SELECT encrypted_value FROM settings WHERE name = ?').get('mqtt');
    if (!row) return null;
    const bytes = Buffer.from(row.encrypted_value, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from('mqtt-settings')); decipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
  }
  nextLinkName(now = Date.now()) {
    const active = this.db.prepare('SELECT label FROM shares WHERE expires_at > ?').all(now);
    const highest = active.reduce((max, row) => Math.max(max, Number(/^Link ([1-9]\d*)$/.exec(row.label)?.[1] || 0)), 0);
    if (!highest) this.db.prepare('UPDATE link_sequence SET next_number = 1 WHERE id = 1').run();
    else this.db.prepare('UPDATE link_sequence SET next_number = MAX(next_number, ?) WHERE id = 1').run(highest + 1);
    return `Link ${this.db.prepare('SELECT next_number FROM link_sequence WHERE id = 1').get().next_number}`;
  }
  create(carId, label, hours, now = Date.now()) {
    const token = randomBytes(32).toString('base64url'), id = randomBytes(12).toString('hex');
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(id));
    const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    const encrypted = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
    label = label?.trim();
    if (!label) {
      label = this.nextLinkName(now);
      this.db.prepare('UPDATE link_sequence SET next_number = next_number + 1 WHERE id = 1').run();
    }
    this.db.prepare('INSERT INTO shares (id, token_hash, car_id, label, expires_at, created_at, encrypted_token) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, hash(token), carId, label, now + hours * 3600000, now, encrypted);
    return { token, id, label, expiresAt: now + hours * 3600000 };
  }
  recover(id, now = Date.now()) {
    const row = this.db.prepare('SELECT encrypted_token, token_hash FROM shares WHERE id = ? AND expires_at > ?').get(id, now);
    if (!row?.encrypted_token) return null;
    const bytes = Buffer.from(row.encrypted_token, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(id));
    decipher.setAuthTag(bytes.subarray(12, 28));
    const token = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
    if (hash(token) !== row.token_hash) throw new Error('Sharing-link integrity check failed');
    return token;
  }
  resolve(token, now = Date.now()) { return this.db.prepare('SELECT id, car_id, expires_at FROM shares WHERE token_hash = ? AND expires_at > ?').get(hash(token), now); }
  list() { return this.db.prepare('SELECT id, car_id, label, expires_at, created_at, encrypted_token IS NOT NULL AS recoverable FROM shares ORDER BY created_at DESC').all(); }
  pruneExpired(now = Date.now()) { return this.db.prepare('DELETE FROM shares WHERE expires_at <= ?').run(now - expiredLinkRetentionMs).changes; }
  revoke(id) { this.db.prepare('DELETE FROM shares WHERE id = ?').run(id); this.emit('revoke'); }
}
