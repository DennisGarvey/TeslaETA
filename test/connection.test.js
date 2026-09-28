import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSettings, MqttConnection } from '../server/mqtt.js';
import { Store } from '../server/store.js';
import { Telemetry } from '../server/telemetry.js';
import { createApp } from '../server/app.js';
test('MQTT transport validation and optional prefixed Cloudflare credentials', () => {
  const settings = normalizeSettings({ transport: 'websocket', url: ' https://broker.example/mqtt ', cloudflare: true, clientId: ' CF-Access-Client-Id: abc.access ', clientSecret: 'cf-access-client-secret: secret-value' });
  assert.equal(settings.url, 'wss://broker.example/mqtt'); assert.equal(settings.clientId, 'abc.access'); assert.equal(settings.clientSecret, 'secret-value');
  const preserved = normalizeSettings({ ...settings, clientId: '', clientSecret: '', password: '' }, { ...settings, password: 'broker-secret' });
  assert.equal(preserved.password, 'broker-secret'); assert.equal(preserved.clientSecret, 'secret-value');
  assert.equal(normalizeSettings({ ...preserved, cloudflare: false, clearPassword: true }).clientSecret, '');
  assert.equal(normalizeSettings({ ...preserved, cloudflare: false, clearPassword: true }).password, '');
  for (const url of ['mqtt://localhost:1883', 'mqtts://broker.example:8883']) assert.equal(normalizeSettings({ transport: 'mqtt', url }).cloudflare, false);
  assert.equal(normalizeSettings({ transport: 'websocket', url: 'ws://broker.example/mqtt' }).cloudflare, false);
  assert.equal(normalizeSettings({ transport: 'mqtt', url: 'wss://broker.example' }).transport, 'websocket');
  assert.equal(normalizeSettings({ transport: 'websocket', url: 'mqtts://broker.example' }).transport, 'mqtt');
  assert.equal(normalizeSettings({ url: 'mqtt://broker.example' }).transport, 'mqtt');
  assert.equal(normalizeSettings({ url: 'https://broker.example' }).transport, 'websocket');
  assert.throws(() => normalizeSettings({ transport: 'websocket', url: 'ws://broker.example', cloudflare: true }), /secure/);
  assert.throws(() => normalizeSettings({ ...settings, clientSecret: 'secret\r\nInjected: header' }), /one token/);
  assert.throws(() => normalizeSettings({ transport: 'mqtt', url: 'mqtt://user:secret@broker' }), /credentials/);
});
test('saved settings are encrypted and admin responses do not expose secrets', async () => {
  const store = new Store(':memory:'), telemetry = new Telemetry(), connection = new MqttConnection(telemetry);
  connection.apply = settings => { connection.settings = settings; connection.status = 'Connecting'; };
  const app = createApp({ telemetry, store, connection, config: { publicOrigin: 'https://eta.example.com' }, verifyAdmin: async () => {} });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const headers = { 'Content-Type': 'application/json', Origin: 'https://eta.example.com', 'X-Requested-With': 'TeslaETA' };
    const settings = { transport: 'websocket', url: 'wss://broker.example/mqtt', cloudflare: true, clientId: 'CF-Access-Client-Id: test-id', clientSecret: 'CF-Access-Client-Secret: test-secret' };
    assert.equal((await fetch(base + '/admin/api/connection', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) })).status, 403);
    const response = await fetch(base + '/admin/api/connection', { method: 'PUT', headers, body: JSON.stringify(settings) });
    assert.equal(response.status, 200); const saved = await response.text();
    assert.ok(!saved.includes('test-secret')); assert.ok(!saved.includes('test-id'));
    assert.equal(store.loadConnection().clientSecret, 'test-secret');
    assert.ok(!JSON.stringify(store.db.prepare('SELECT * FROM settings').all()).includes('test-secret'));
    const read = await (await fetch(base + '/admin/api/connection')).json(); assert.equal(read.hasClientSecret, true); assert.equal(read.clientSecret, undefined);
  } finally { await new Promise(resolve => server.close(resolve)); store.db.close(); }
});
