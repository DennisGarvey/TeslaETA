import test from 'node:test';
import assert from 'node:assert/strict';
import { Telemetry } from '../server/telemetry.js';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
const route = { destination: 'Home', minutes_to_arrival: 20, miles_to_arrival: 5, location: { latitude: 40, longitude: -74 } };
test('retained data is not live; ETA anchored to route update; clear route and stale handling', () => {
  const t = new Telemetry(); t.connected = true;
  t.ingest('teslamate/cars/1/active_route', Buffer.from(JSON.stringify(route)), true, 1000);
  assert.equal(t.snapshot('1', 2000).arrivalAt, null);
  t.ingest('teslamate/cars/1/active_route', Buffer.from(JSON.stringify(route)), false, 3000);
  assert.equal(t.snapshot('1', 5000).arrivalAt, 1203000);
  assert.equal(t.snapshot('1', 130000).arrivalAt, null);
  t.ingest('teslamate/cars/1/active_route', Buffer.from('{"error":"No active route available"}'));
  assert.equal(t.snapshot('1').route, null);
  t.ingest('teslamate/cars/1/location', Buffer.from('{"latitude":999,"longitude":0}'));
  assert.equal(t.snapshot('1').location, null);
});
test('share token hashed, expiry enforced, revocation immediate', () => {
  const store = new Store(':memory:');
  const share = store.create('1', 'Trip', 1, 1000);
  assert.equal(store.resolve(share.token, 1001).car_id, '1');
  assert.equal(store.resolve(share.token, 3601000), undefined);
  assert.ok(!JSON.stringify(store.list()).includes(share.token));
  store.revoke(share.id); assert.equal(store.resolve(share.token, 1001), undefined); store.db.close();
});
test('admin fails closed and public sharing scopes data to the selected car', async () => {
  const telemetry = new Telemetry(), store = new Store(':memory:');
  telemetry.ingest('teslamate/cars/1/display_name', Buffer.from('Car one'));
  telemetry.ingest('teslamate/cars/2/display_name', Buffer.from('Private car'));
  const config = { demo: false, publicOrigin: 'https://eta.example.com' };
  const app = createApp({ telemetry, store, config });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const path of ['/admin', '/admin/', '/admin/api/status', '/admin/api/shares', '/admin/api/shares/example/link', '/admin/api/connection', '/admin/api/sharing-settings', '/admin/api/viewers/events', '/admin/app.js']) assert.equal((await fetch(base + path)).status, 403);
    const share = store.create('1', 'Trip', 1);
    const response = await fetch(`${base}/s/${share.token}/data`);
    const data = await response.json(); assert.equal(data.name, 'Car one'); assert.ok(!JSON.stringify(data).includes('Private car'));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    store.revoke(share.id); assert.equal((await fetch(`${base}/s/${share.token}/data`)).status, 404);
  } finally { await new Promise(resolve => server.close(resolve)); store.db.close(); }
});
test('admin mutations reject cross-origin requests, then allow create and revoke', async () => {
  const telemetry = new Telemetry(), store = new Store(':memory:');
  telemetry.ingest('teslamate/cars/1/display_name', Buffer.from('Car'));
  const app = createApp({ telemetry, store, config: { demo: false, publicOrigin: 'https://eta.example.com' }, verifyAdmin: async () => {} });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const body = JSON.stringify({ carId: '1', label: 'Trip', hours: 1 });
    assert.equal((await fetch(base + '/admin/api/shares', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status, 403);
    const headers = { 'Content-Type': 'application/json', origin: 'https://eta.example.com', 'X-Requested-With': 'TeslaETA' };
    const response = await fetch(base + '/admin/api/shares', { method: 'POST', headers, body }); assert.equal(response.status, 201);
    const share = await response.json(); assert.ok(share.url.startsWith('https://eta.example.com/s/'));
    const recovered = await fetch(base + `/admin/api/shares/${share.id}/link`);
    assert.equal(recovered.status, 200);
    assert.equal((await recovered.json()).url, share.url);
    assert.equal((await fetch(base + `/admin/api/shares/${share.id}`, { method: 'DELETE', headers })).status, 204);
    assert.equal((await fetch(base + `/s/${share.token}/data`)).status, 404);
    assert.equal((await fetch(base + `/admin/api/shares/${share.id}/link`)).status, 404);
  } finally { await new Promise(resolve => server.close(resolve)); store.db.close(); }
});

import { enforceReadOnly } from '../server/read-only.js';
test('read-only client rejects publish, async publish, and last wills', async () => {
  const client = enforceReadOnly({ options: {} });
  assert.throws(() => client.publish('anything', 'payload'), /read-only/);
  await assert.rejects(() => client.publishAsync('anything', 'payload'), /read-only/);
  assert.throws(() => enforceReadOnly({ options: { will: { topic: 'anything' } } }), /last will/);
});

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
test('encrypted links recover after restart, expire, and migrate legacy records safely', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eta-recovery-')), path = join(dir, 'eta.sqlite');
  const now = Date.now();
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec('CREATE TABLE shares (id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, car_id TEXT NOT NULL, label TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL)');
    legacy.prepare('INSERT INTO shares VALUES (?, ?, ?, ?, ?, ?)').run('old', 'old-hash', '1', 'Older link', 9999999, 1000); legacy.close();
    let store = new Store(path);
    assert.equal(store.recover('old', 1001), null);
    const share = store.create('1', 'New link', 1, now);
    assert.equal(store.recover(share.id, now + 1), share.token);
    assert.ok(!JSON.stringify(store.db.prepare('SELECT * FROM shares').all()).includes(share.token));
    store.db.close();
    assert.ok(!readFileSync(path).includes(Buffer.from(share.token)));
    store = new Store(path);
    assert.equal(store.recover(share.id, now + 1000), share.token);
    assert.equal(store.recover(share.id, now + 3600000), null);
    store.revoke(share.id); assert.equal(store.recover(share.id, now + 1000), null);
    store.db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('expired links remain removable for 24 hours, then are pruned', () => {
  const store = new Store(':memory:');
  const now = Date.now(), hour = 60 * 60 * 1000;
  try {
    const old = store.create('1', 'Old', 1, now - 25 * hour - 1);
    const boundary = store.create('1', 'Boundary', 1, now - 25 * hour);
    const recent = store.create('1', 'Recent', 1, now - 25 * hour + 1);
    const active = store.create('1', 'Active', 1, now);
    assert.equal(store.pruneExpired(now - 1), 1);
    assert.deepEqual(store.list().map(share => share.id).sort(), [boundary.id, recent.id, active.id].sort());
    assert.equal(store.pruneExpired(now), 1);
    assert.deepEqual(store.list().map(share => share.id).sort(), [recent.id, active.id].sort());
    assert.equal(store.pruneExpired(now + 1), 1);
    assert.deepEqual(store.list().map(share => share.id), [active.id]);
    assert.ok(!store.list().some(share => share.id === old.id));
  } finally { store.db.close(); }
});

test('startup removes links more than 24 hours past expiry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eta-prune-')), path = join(dir, 'eta.sqlite');
  const now = Date.now(), hour = 60 * 60 * 1000;
  let store;
  try {
    store = new Store(path);
    const old = store.create('1', 'Old', 1, now - 25 * hour - 1000);
    const recent = store.create('1', 'Recent', 1, now - 25 * hour + 60_000);
    store.db.close();
    store = new Store(path);
    assert.deepEqual(store.list().map(share => share.id), [recent.id]);
    assert.ok(!store.list().some(share => share.id === old.id));
  } finally { store?.db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('generic sequence persists while numbered links remain active', () => {
  const dir = mkdtempSync(join(tmpdir(), 'eta-names-')), path = join(dir, 'eta.sqlite');
  try {
    let store = new Store(path);
    assert.equal(store.nextLinkName(), 'Link 1');
    const first = store.create('1', '', 1); assert.equal(first.label, 'Link 1');
    assert.equal(store.create('1', '   ', 1).label, 'Link 2');
    store.revoke(first.id); store.db.close();
    store = new Store(path);
    assert.equal(store.nextLinkName(), 'Link 3');
    assert.equal(store.create('1', undefined, 1).label, 'Link 3');
    assert.equal(store.create('1', 'Family', 1).label, 'Family');
    store.db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('numbering resets after all generic links are revoked or expired, ignoring custom names', () => {
  const store = new Store(':memory:');
  try {
    store.create('1', 'Family', 24, 1000);
    const first = store.create('1', '', 1, 1000);
    const second = store.create('1', '', 1, 1000);
    assert.equal(first.label, 'Link 1'); assert.equal(second.label, 'Link 2');
    store.revoke(first.id);
    assert.equal(store.nextLinkName(2000), 'Link 3');
    store.revoke(second.id);
    assert.equal(store.nextLinkName(2000), 'Link 1');
    assert.equal(store.create('1', '', 1, 2000).label, 'Link 1');
    assert.equal(store.create('1', '', 1, 3602000).label, 'Link 1');
    assert.equal(store.create('1', '', 1, 3602001).label, 'Link 2');
  } finally { store.db.close(); }
});
