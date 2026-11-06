import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.js';
import { Telemetry } from '../server/telemetry.js';
import { createApp } from '../server/app.js';
import { resolveExpiration } from '../public/expiration.js';

test('browser and server share validation without imposing an extra date offset', () => {
  const now = 1000000;
  assert.deepEqual(resolveExpiration({ expiresAt: now + 1 }, now), { expiresAt: now + 1, error: null });
  assert.deepEqual(resolveExpiration({ hours: 1 / 60 }, now), { expiresAt: now + 60000, error: null });
  assert.deepEqual(resolveExpiration({ hours: 168 }, now), { expiresAt: now + 7 * 86400000, error: null });
  for (const input of [{ expiresAt: now }, { expiresAt: now - 1 }, { expiresAt: NaN }, { expiresAt: null }, { hours: 0 }, { hours: -1 }, { hours: 169 }, {}]) {
    assert.ok(resolveExpiration(input, now).error);
  }
});

test('custom durations, explicit dates and active-link edits preserve tokens and reject invalid expirations', async () => {
  const store = new Store(':memory:'), telemetry = new Telemetry();
  telemetry.ingest('teslamate/cars/1/display_name', Buffer.from('Test vehicle'));
  const server = createApp({ telemetry, store, config: { localPreview: true, publicOrigin: 'http://localhost' } }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/admin/api/shares`;
  const request = (path, method, body) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    let response = await request('', 'POST', { carId: '1', hours: 0.75 });
    assert.equal(response.status, 201);
    const share = await response.json(), token = store.recover(share.id);
    assert.ok(Math.abs(share.expiresAt - Date.now() - 45 * 60000) < 2000);
    const expiresAt = Date.now() + 2 * 3600000;
    response = await request(`/${share.id}/expiration`, 'PATCH', { expiresAt });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).expiresAt, expiresAt);
    assert.equal(store.recover(share.id), token);
    assert.equal(store.resolve(token).expires_at, expiresAt);
    response = await request('', 'POST', { carId: '1', expiresAt });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).expiresAt, expiresAt);
    for (const body of [{ hours: 0 }, { hours: -1 }, { hours: 169 }, { expiresAt: Date.now() - 1 }, { expiresAt: 'tomorrow' }, { expiresAt: Date.now() + 8 * 86400000 }]) {
      assert.equal((await request('', 'POST', { carId: '1', ...body })).status, 400);
      assert.equal((await request(`/${share.id}/expiration`, 'PATCH', body)).status, 400);
    }
    const expired = store.create('1', 'Expired', 1, Date.now() - 2 * 3600000);
    assert.equal(store.resolve(expired.token), undefined);
    assert.equal((await request(`/${expired.id}/expiration`, 'PATCH', { hours: 1 })).status, 200);
    assert.equal(store.recover(expired.id), expired.token);
    assert.equal(store.resolve(expired.token).id, expired.id);
    const tooOld = store.create('1', 'Old expired', 1, Date.now() - 26 * 3600000);
    assert.equal((await request(`/${tooOld.id}/expiration`, 'PATCH', { hours: 1 })).status, 404);
    store.revoke(share.id);
    assert.equal((await request(`/${share.id}/expiration`, 'PATCH', { hours: 1 })).status, 404);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.db.close(); }
});
