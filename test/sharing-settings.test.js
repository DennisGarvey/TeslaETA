import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSharingOrigin } from '../server/sharing-settings.js';
import { createApp } from '../server/app.js';
import { Store } from '../server/store.js';
import { Telemetry } from '../server/telemetry.js';
test('public origin validation permits HTTPS and local-preview loopback only', () => {
  assert.equal(normalizeSharingOrigin(' https://eta.example.com/ '), 'https://eta.example.com');
  assert.equal(normalizeSharingOrigin('http://127.0.0.1:3000', true), 'http://127.0.0.1:3000');
  for (const url of ['http://eta.example.com', 'https://eta.example.com/path', 'https://user:secret@eta.example.com', 'https://eta.example.com?q=1', 'javascript:alert(1)']) assert.throws(() => normalizeSharingOrigin(url, true));
  assert.throws(() => normalizeSharingOrigin('http://localhost:3000'));
});
test('saved sharing origin applies to created and recovered URLs without changing admin origin', async () => {
  const store = new Store(':memory:'), telemetry = new Telemetry();
  telemetry.ingest('teslamate/cars/1/display_name', Buffer.from('Car'));
  const config = { publicOrigin: 'https://admin.example.com' };
  const server = createApp({ store, telemetry, config, verifyAdmin: async () => {} }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'Content-Type': 'application/json', Origin: config.publicOrigin, 'X-Requested-With': 'TeslaETA' };
  try {
    assert.equal((await (await fetch(base + '/admin/api/sharing-settings')).json()).publicOrigin, config.publicOrigin);
    const body = JSON.stringify({ publicOrigin: 'https://share.example.com/' });
    assert.equal((await fetch(base + '/admin/api/sharing-settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body })).status, 403);
    assert.equal((await fetch(base + '/admin/api/sharing-settings', { method: 'PUT', headers, body })).status, 200);
    assert.equal(store.sharingOrigin(), 'https://share.example.com');
    const share = await (await fetch(base + '/admin/api/shares', { method: 'POST', headers, body: JSON.stringify({ carId: '1', hours: 1 }) })).json();
    assert.equal(share.url, `https://share.example.com/s/${share.token}`);
    assert.equal((await (await fetch(base + `/admin/api/shares/${share.id}/link`)).json()).url, share.url);
    assert.equal(config.publicOrigin, 'https://admin.example.com');
    assert.equal((await fetch(base + '/admin/api/sharing-settings', { method: 'PUT', headers: { ...headers, Origin: 'https://share.example.com' }, body })).status, 403);
  } finally { await new Promise(resolve => server.close(resolve)); store.db.close(); }
});
