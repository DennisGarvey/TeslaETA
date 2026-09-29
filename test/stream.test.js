import test from 'node:test';
import assert from 'node:assert/strict';
import { Telemetry } from '../server/telemetry.js';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
async function fixture() {
  const telemetry = new Telemetry(), store = new Store(':memory:');
  telemetry.connected = true;
  telemetry.ingest('teslamate/cars/1/display_name', Buffer.from('Shared car'));
  telemetry.ingest('teslamate/cars/2/display_name', Buffer.from('Private car'));
  const app = createApp({ telemetry, store, config: { localPreview: true } });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  return { telemetry, store, server, base: `http://127.0.0.1:${server.address().port}` };
}
async function openStream(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(6000) });
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader(); let buffer = '';
  return { reader, async event() {
    while (true) {
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        if (frame.startsWith('event:')) return { type: frame.match(/event: (.*)/)[1], data: JSON.parse(frame.match(/data: (.*)/)[1]) };
      }
      const { value, done } = await reader.read(); if (done) throw new Error('Stream ended before event'); buffer += new TextDecoder().decode(value);
    }
  } };
}
test('SSE pushes scoped updates, disconnect state, and revocation; removes listeners', { timeout: 8000 }, async () => {
  const f = await fixture(); let stream;
  try {
    const share = f.store.create('1', 'Trip', 1);
    stream = await openStream(`${f.base}/s/${share.token}/events`);
    const initial = await stream.event(); assert.equal(initial.data.name, 'Shared car'); assert.ok(!JSON.stringify(initial).includes('Private car'));
    f.telemetry.ingest('teslamate/cars/2/speed', Buffer.from('99'));
    f.telemetry.ingest('teslamate/cars/1/speed', Buffer.from('42'));
    const next = await stream.event(); assert.equal(next.data.speed, 42); assert.equal(next.data.id, '1');
    f.telemetry.connected = false; assert.equal((await stream.event()).data.connected, false);
    f.store.revoke(share.id); assert.equal((await stream.event()).type, 'ended');
    assert.equal(f.telemetry.listenerCount('update'), 0); assert.equal(f.store.listenerCount('revoke'), 0);
  } finally { await stream?.reader.cancel(); f.server.closeAllConnections(); await new Promise(resolve => f.server.close(resolve)); f.store.db.close(); }
});
test('SSE terminates expired and invalid links without exposing telemetry', { timeout: 8000 }, async () => {
  const f = await fixture(); let stream;
  try {
    stream = await openStream(`${f.base}/s/invalid/events`); assert.equal((await stream.event()).type, 'ended'); await stream.reader.cancel();
    const share = f.store.create('1', 'Trip', 1);
    f.store.db.prepare('UPDATE shares SET expires_at = ? WHERE id = ?').run(Date.now() + 500, share.id);
    stream = await openStream(`${f.base}/s/${share.token}/events`); assert.equal((await stream.event()).type, 'snapshot');
    assert.equal((await stream.event()).type, 'ended');
  } finally { await stream?.reader.cancel(); f.server.closeAllConnections(); await new Promise(resolve => f.server.close(resolve)); f.store.db.close(); }
});

test('live admin counts track joins, disconnects, per-link isolation and revocation', { timeout: 8000 }, async () => {
  const f = await fixture(); const streams = [];
  try {
    const one = f.store.create('1', 'First', 1), two = f.store.create('1', 'Second', 1);
    const admin = await openStream(`${f.base}/admin/api/viewers/events`); streams.push(admin);
    assert.deepEqual((await admin.event()).data, {});
    assert.deepEqual(await admin.event(), { type: 'connection', data: { connected: true, configured: false } });
    const a = await openStream(`${f.base}/s/${one.token}/events`); streams.push(a); await a.event();
    assert.equal((await admin.event()).data[one.id], 1);
    const b = await openStream(`${f.base}/s/${one.token}/events`); streams.push(b); await b.event();
    assert.equal((await admin.event()).data[one.id], 2);
    const c = await openStream(`${f.base}/s/${two.token}/events`); streams.push(c); await c.event();
    assert.deepEqual((await admin.event()).data, { [one.id]: 2, [two.id]: 1 });
    await a.reader.cancel();
    assert.deepEqual((await admin.event()).data, { [one.id]: 1, [two.id]: 1 });
    const listed = await (await fetch(`${f.base}/admin/api/shares`)).json();
    assert.equal(listed.find(share => share.id === one.id).viewers, 1);
    f.store.revoke(one.id); await b.event();
    assert.deepEqual((await admin.event()).data, { [two.id]: 1 });
    await c.reader.cancel(); assert.deepEqual((await admin.event()).data, {});
    f.telemetry.connected = false;
    assert.deepEqual(await admin.event(), { type: 'connection', data: { connected: false, configured: false } });
  } finally {
    for (const stream of streams) await stream.reader.cancel().catch(() => {});
    f.server.closeAllConnections(); await new Promise(resolve => f.server.close(resolve)); f.store.db.close();
  }
});
