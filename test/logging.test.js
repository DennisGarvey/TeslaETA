import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createLogger, errorDetails } from '../server/logger.js';
import { MqttConnection, normalizeSettings } from '../server/mqtt.js';
import { Telemetry } from '../server/telemetry.js';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';

function captureLogs() {
  const lines = [];
  return { lines, logger: createLogger({ now: () => new Date('2026-10-26T16:04:12Z'), write: line => lines.push(line) }) };
}

test('logs include timestamps and levels, and error details never include arbitrary messages or stacks', () => {
  const { lines, logger } = captureLogs();
  logger.info('Tesla ETA listening', { port: 3001 });
  logger.warn('MQTT connection failed; retrying', errorDetails(Object.assign(new Error('wss://private.example/secret-token CF-Access-Client-Secret: secret'), { code: 'ECONNREFUSED' })));
  logger.error('Request failed', errorDetails(new Error('SQL statement with private location')));
  assert.equal(lines[0], '2026-10-26T16:04:12.000Z INFO Tesla ETA listening port=3001');
  assert.match(lines[1], /WARN MQTT connection failed; retrying reason="Connection refused" code="ECONNREFUSED"$/);
  assert.match(lines[2], /ERROR Request failed reason="Unexpected error"$/);
  assert.deepEqual(errorDetails(new Error('Unexpected server response: 403')), { reason: 'WebSocket handshake rejected', httpStatus: 403 });
  assert.deepEqual(errorDetails(Object.assign(new Error('private broker error'), { code: 5 })), { reason: 'Broker authorization rejected', mqttCode: 5 });
  assert.deepEqual(errorDetails(Object.assign(new Error('private error'), { code: 'secret-token' })), { reason: 'Unexpected error' });
  assert.ok(!lines.join('\n').includes('secret'));
  assert.ok(!lines.join('\n').includes('private'));
});

function fakeClient() {
  const client = new EventEmitter();
  client.options = {};
  client.granted = [{ topic: 'teslamate/cars/+/+', qos: 0 }];
  client.subscribe = (topic, options, callback) => callback(null, client.granted);
  client.end = () => client.emit('close');
  return client;
}

test('MQTT failures are deduplicated per outage and recovery summarizes retries without telemetry or credentials', () => {
  const { lines, logger } = captureLogs(), telemetry = new Telemetry(), clients = [];
  let now = 0;
  const connection = new MqttConnection(telemetry, { logger, now: () => now, connect: () => {
    const client = fakeClient(); clients.push(client); return client;
  } });
  const settings = normalizeSettings({ url: 'wss://private.example/mqtt', cloudflare: true, clientId: 'private-id', clientSecret: 'private-secret' });
  connection.apply(settings);
  const client = clients[0];
  const error = Object.assign(new Error('wss://private.example private-secret'), { code: 'ECONNREFUSED' });
  client.emit('error', error);
  for (let i = 0; i < 5; ++i) { client.emit('close'); client.emit('reconnect'); client.emit('error', error); }
  assert.equal(lines.length, 1);
  assert.equal(telemetry.connected, false);
  now = 12000;
  client.emit('connect');
  assert.equal(telemetry.connected, true);
  assert.match(lines[1], /INFO MQTT connected transport="websocket" outageSeconds=12 retries=5$/);
  client.emit('connect');
  client.emit('message', 'teslamate/cars/1/location', Buffer.from('{"latitude":40,"longitude":-74}'), { retain: false });
  assert.equal(lines.length, 2);
  now = 20000;
  client.emit('close');
  client.emit('error', error);
  const warnings = lines.length;
  for (let i = 0; i < 4; ++i) { client.emit('reconnect'); client.emit('error', error); client.emit('close'); }
  assert.equal(lines.length, warnings);
  now = 35000;
  client.emit('connect');
  assert.match(lines.at(-1), /INFO MQTT reconnected transport="websocket" outageSeconds=15 retries=4$/);
  const recovered = lines.length;
  connection.apply(settings);
  client.emit('error', error); client.emit('reconnect'); client.emit('connect');
  assert.equal(lines.length, recovered);
  clients[1].emit('connect');
  assert.match(lines.at(-1), /INFO MQTT connected transport="websocket"$/);
  const beforeClose = lines.length;
  connection.close();
  clients[1].emit('error', error);
  assert.equal(lines.length, beforeClose);
  assert.throws(() => client.publish('anything', 'payload'), /read-only/);
  assert.ok(!lines.join('\n').match(/private|latitude|longitude|teslamate\/cars/));
});

test('MQTT subscription rejection is logged once and never reported as a successful connection', () => {
  const { lines, logger } = captureLogs(), telemetry = new Telemetry(), client = fakeClient();
  const connection = new MqttConnection(telemetry, { logger, connect: () => client });
  connection.apply(normalizeSettings({ url: 'mqtt://broker.example' }));
  client.granted = [{ qos: 128 }];
  client.emit('connect'); client.emit('connect');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /WARN MQTT subscription rejected/);
  assert.equal(telemetry.connected, false);
  client.granted = [{ qos: 0 }];
  client.emit('connect');
  assert.equal(telemetry.connected, true);
  assert.match(lines.at(-1), /INFO MQTT connected/);
  connection.close();
});

test('admin logs contain internal link IDs and safe error details, without request URLs, labels or secrets', async () => {
  const { lines, logger } = captureLogs(), telemetry = new Telemetry(), store = new Store(':memory:');
  telemetry.ingest('teslamate/cars/1/display_name', Buffer.from('Private vehicle'));
  const connection = { publicSettings: () => ({}), apply() {} };
  const app = createApp({ telemetry, store, connection, logger, config: { publicOrigin: 'https://eta.example.com', adminAuthMode: 'external' } });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'Content-Type': 'application/json', Origin: 'https://eta.example.com', 'X-Requested-With': 'TeslaETA' };
  const put = (path, body) => fetch(base + path, { method: 'PUT', headers, body: JSON.stringify(body) });
  const create = () => fetch(base + '/admin/api/shares', { method: 'POST', headers, body: JSON.stringify({ carId: '1', label: 'Private destination', hours: 1 }) });
  const remove = id => fetch(`${base}/admin/api/shares/${id}`, { method: 'DELETE', headers });
  try {
    assert.equal((await put('/admin/api/connection', { url: 'wss://private.example/mqtt', cloudflare: true, clientId: 'private-client-id', clientSecret: 'private-client-secret', password: 'private-password' })).status, 200);
    assert.equal((await put('/admin/api/sharing-settings', { publicOrigin: 'https://private.example' })).status, 200);
    const share = await (await create()).json();
    assert.equal((await fetch(`${base}/admin/api/shares/${share.id}/link`)).status, 200);
    assert.equal((await remove(share.id)).status, 204);
    const expired = await (await create()).json();
    store.db.prepare('UPDATE shares SET expires_at = ? WHERE id = ?').run(Date.now() - 1, expired.id);
    assert.equal((await remove(expired.id)).status, 204);
    assert.equal((await remove('private-token')).status, 204);
    assert.equal((await fetch(base + '/healthz')).status, 200);
    assert.equal((await fetch(base + '/admin/api/shares', { method: 'POST', headers, body: '{private-invalid-json' })).status, 400);
    store.resolve = () => { throw Object.assign(new Error('SQL error with private location'), { code: 'ERR_SQLITE_ERROR', errcode: 10 }); };
    assert.equal((await fetch(`${base}/s/${share.token}/data?private-query`)).status, 500);
    assert.equal(lines.length, 7);
    assert.match(lines[0], /INFO MQTT settings saved$/);
    assert.match(lines[1], /INFO Sharing URL changed$/);
    assert.match(lines[2], new RegExp(`INFO Sharing link created linkId="${share.id}"$`));
    assert.match(lines[3], new RegExp(`INFO Sharing link revoked linkId="${share.id}"$`));
    assert.match(lines[5], new RegExp(`INFO Expired sharing link removed linkId="${expired.id}"$`));
    assert.match(lines[6], /ERROR Request failed operation="\/s\/:token\/data" reason="Database error" code="ERR_SQLITE_ERROR" sqliteCode=10$/);
    assert.ok(!lines.join('\n').includes(share.token));
    assert.ok(!lines.join('\n').includes(expired.token));
    assert.ok(!lines.join('\n').match(/private|Private/));
  } finally { await new Promise(resolve => server.close(resolve)); store.db.close(); }
});

function launch(env) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server/index.js', import.meta.url))], {
    env: { PORT: '0', PUBLIC_ORIGIN: 'https://eta.example.com', ADMIN_AUTH_MODE: 'external', DATABASE_PATH: ':memory:', ...env }
  });
  const output = { stdout: '', stderr: '' };
  child.stdout.on('data', chunk => { output.stdout += chunk; });
  child.stderr.on('data', chunk => { output.stderr += chunk; });
  return { child, output, exited: once(child, 'close') };
}

test('server startup reports the auth mode and MQTT source, then logs a clean container shutdown', { timeout: 10000 }, async t => {
  const { child, output, exited } = launch();
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', () => { if (output.stdout.includes('Tesla ETA listening')) resolve(); });
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Server exited before listening (${code}): ${output.stderr}`)));
  });
  child.kill('SIGTERM');
  assert.equal((await exited)[0], 0);
  assert.match(output.stdout, /INFO Tesla ETA listening port=\d+ adminAuth="external" mqttSettings="not configured"/);
  assert.match(output.stdout, /INFO Shutting down signal="SIGTERM"/);
  assert.equal(output.stdout.trim().split('\n').length, 2);
});

test('startup failure is actionable without printing the invalid URL or an unsanitized stack', { timeout: 10000 }, async t => {
  const { child, output, exited } = launch({ PUBLIC_ORIGIN: 'private-invalid-origin' });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  assert.equal((await exited)[0], 1);
  assert.match(output.stderr, /ERROR Startup failed reason="Invalid URL" code="ERR_INVALID_URL"/);
  assert.ok(!output.stderr.includes('private-invalid-origin'));
  assert.ok(!output.stderr.includes('at loadConfig'));
});
