import test from 'node:test';
import assert from 'node:assert/strict';
import { Telemetry } from '../server/telemetry.js';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import { EventEmitter } from 'node:events';
import { streamShare } from '../server/stream.js';
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
    const line = Buffer.from('????').toString('base64');
    f.telemetry.ingest('teslamate/cars/2/route_line', Buffer.from(Buffer.from('@@AA').toString('base64')));
    f.telemetry.ingest('teslamate/cars/1/route_line', Buffer.from(line));
    const routed = await stream.event(); assert.equal(routed.data.routeLine, line);
    f.telemetry.ingest('teslamate/cars/1/route_line', Buffer.alloc(0));
    assert.equal((await stream.event()).data.routeLine, null);
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

test('a large route snapshot stays connected and continues to receive scoped updates', { timeout: 8000 }, async () => {
  const f = await fixture(); let stream;
  try {
    const line = Buffer.from('??'.repeat(40000)).toString('base64');
    assert.ok(line.length > 65536);
    f.telemetry.ingest('teslamate/cars/1/route_line', Buffer.from(line));
    const share = f.store.create('1', 'Trip', 1);
    stream = await openStream(`${f.base}/s/${share.token}/events`);
    assert.equal((await stream.event()).data.routeLine, line);
    f.telemetry.ingest('teslamate/cars/1/speed', Buffer.from('42'));
    const next = await stream.event();
    assert.equal(next.data.routeLine, undefined); assert.equal(next.data.speed, 42);
    f.telemetry.cars.clear(); f.telemetry.emit('connection');
    const waiting = await stream.event();
    assert.equal(waiting.data.waiting, true); assert.equal(waiting.data.routeLine, null);
  } finally { await stream?.reader.cancel(); f.server.closeAllConnections(); await new Promise(resolve => f.server.close(resolve)); f.store.db.close(); }
});

test('a pending RouteLine is streamed when delayed TeslaMate metadata catches up, without republishing the line', { timeout: 8000 }, async () => {
  const f = await fixture(); let stream;
  try {
    const line = Buffer.from('????').toString('base64');
    const inactive = Buffer.from('{"error":"No active route available"}');
    const active = Buffer.from('{"location":{"latitude":0,"longitude":0},"destination":"Trip"}');
    f.telemetry.ingest('teslamate/cars/1/active_route', inactive);
    f.telemetry.ingest('teslamate/cars/1/route_line', Buffer.from(line));
    const share = f.store.create('1', 'Trip', 1);
    stream = await openStream(`${f.base}/s/${share.token}/events`);
    assert.equal((await stream.event()).data.routeLine, null);
    f.telemetry.ingest('teslamate/cars/1/active_route', active);
    assert.equal((await stream.event()).data.routeLine, line);
    f.telemetry.ingest('teslamate/cars/1/active_route', inactive);
    assert.equal((await stream.event()).data.routeLine, null);
    f.telemetry.ingest('teslamate/cars/1/active_route', active);
    assert.equal((await stream.event()).data.routeLine, line);
  } finally { await stream?.reader.cancel(); f.server.closeAllConnections(); await new Promise(resolve => f.server.close(resolve)); f.store.db.close(); }
});

test('SSE keeps the old matching line until the new destination arrives and immediately sends same-destination reroutes', { timeout: 8000 }, async () => {
  const f = await fixture(); let stream;
  try {
    const oldLine = Buffer.from('????').toString('base64');
    const polyline = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';
    const newLine = Buffer.from(polyline).toString('base64');
    const destination = { latitude: 4.3252, longitude: -12.6453 };
    f.telemetry.ingest('teslamate/cars/1/active_route', Buffer.from('{"location":{"latitude":0,"longitude":0},"destination":"Old"}'));
    f.telemetry.ingest('teslamate/cars/1/route_line', Buffer.from(oldLine));
    const share = f.store.create('1', 'Trip', 1);
    stream = await openStream(`${f.base}/s/${share.token}/events`);
    assert.equal((await stream.event()).data.routeLine, oldLine);
    f.telemetry.ingest('teslamate/cars/1/route_line', Buffer.from(newLine));
    const pending = await stream.event();
    assert.equal(pending.data.routeLine, undefined);
    assert.equal(pending.data.route.destination, 'Old');
    assert.equal(f.telemetry.snapshot('1').routeLine, oldLine);
    f.telemetry.ingest('teslamate/cars/1/active_route', Buffer.from(JSON.stringify({ location: destination, destination: 'New' })));
    const matched = await stream.event();
    assert.equal(matched.data.routeLine, newLine);
    assert.deepEqual(matched.data.route.location, destination);
    const rerouted = Buffer.from(polyline + '??').toString('base64');
    f.telemetry.ingest('teslamate/cars/1/route_line', Buffer.from(rerouted));
    const immediate = await stream.event();
    assert.equal(immediate.data.routeLine, rerouted);
    assert.deepEqual(immediate.data.route.location, destination);
  } finally { await stream?.reader.cancel(); f.server.closeAllConnections(); await new Promise(resolve => f.server.close(resolve)); f.store.db.close(); }
});

test('SSE keeps a clearing route visible until TeslaMate clears its destination, then removes both together', { timeout: 8000 }, async () => {
  const f = await fixture(); let stream;
  try {
    const line = Buffer.from('????').toString('base64');
    f.telemetry.ingest('teslamate/cars/1/active_route', Buffer.from('{"location":{"latitude":0,"longitude":0},"destination":"Trip"}'));
    f.telemetry.ingest('teslamate/cars/1/route_line', Buffer.from(line));
    const share = f.store.create('1', 'Trip', 1);
    stream = await openStream(`${f.base}/s/${share.token}/events`);
    assert.equal((await stream.event()).data.routeLine, line);
    f.telemetry.ingest('teslamate/cars/1/route_line', Buffer.from(Buffer.from([0x12, 0]).toString('base64')));
    const pending = await stream.event();
    assert.equal(pending.data.routeLine, undefined);
    assert.equal(pending.data.route.destination, 'Trip');
    assert.equal(f.telemetry.snapshot('1').routeLine, line);
    f.telemetry.ingest('teslamate/cars/1/active_route', Buffer.from('{"error":"No active route available"}'));
    const cleared = await stream.event();
    assert.equal(cleared.data.routeLine, null); assert.equal(cleared.data.route, null);
  } finally { await stream?.reader.cancel(); f.server.closeAllConnections(); await new Promise(resolve => f.server.close(resolve)); f.store.db.close(); }
});

test('nearby endpoints do not switch early on SSE, and an offset TeslaMate pin is preserved', { timeout: 8000 }, async () => {
  const f = await fixture(); let stream;
  try {
    const oldLine = Buffer.from('????').toString('base64');
    const polyline = '??o}@?';
    const newLine = Buffer.from(polyline).toString('base64');
    const oldPin = { latitude: 0, longitude: -0.001 };
    const newPin = { latitude: 0.001, longitude: -0.001 };
    const navigation = (location, destination) => Buffer.from(JSON.stringify({ location, destination }));
    f.telemetry.ingest('teslamate/cars/1/active_route', navigation(oldPin, 'Old'));
    f.telemetry.ingest('teslamate/cars/1/route_line', Buffer.from(oldLine));
    const share = f.store.create('1', 'Trip', 1);
    stream = await openStream(`${f.base}/s/${share.token}/events`);
    assert.equal((await stream.event()).data.routeLine, oldLine);
    f.telemetry.ingest('teslamate/cars/1/route_line', Buffer.from(newLine));
    const pending = await stream.event();
    assert.equal(pending.data.routeLine, undefined);
    assert.deepEqual(pending.data.route.location, oldPin);
    assert.equal(f.telemetry.snapshot('1').routeLine, oldLine);
    f.telemetry.ingest('teslamate/cars/1/active_route', navigation(newPin, 'New'));
    const matched = await stream.event();
    assert.equal(matched.data.routeLine, newLine);
    assert.deepEqual(matched.data.route.location, newPin);
    const rerouted = Buffer.from(polyline + '??').toString('base64');
    f.telemetry.ingest('teslamate/cars/1/route_line', Buffer.from(rerouted));
    const immediate = await stream.event();
    assert.equal(immediate.data.routeLine, rerouted);
    assert.deepEqual(immediate.data.route.location, newPin);
  } finally { await stream?.reader.cancel(); f.server.closeAllConnections(); await new Promise(resolve => f.server.close(resolve)); f.store.db.close(); }
});

test('a blocked viewer coalesces updates until drain instead of accumulating snapshots', { timeout: 3000 }, async () => {
  const telemetry = new Telemetry(), store = new Store(':memory:'), res = new EventEmitter();
  const share = store.create('1', 'Trip', 1), frames = [];
  let full = true, ended = false;
  res.set = res.flushHeaders = () => {};
  res.write = frame => { frames.push(frame); return !full || !frame.startsWith('event: snapshot'); };
  res.end = res.destroy = () => { ended = true; };
  try {
    streamShare({ params: { token: share.token } }, res, { telemetry, store, config: {} });
    for (let i = 0; i < 100; i++) telemetry.ingest('teslamate/cars/1/speed', Buffer.from(String(i)));
    await new Promise(resolve => setTimeout(resolve, 180));
    assert.equal(frames.filter(frame => frame.startsWith('event: snapshot')).length, 1);
    assert.equal(ended, false);
    full = false; res.emit('drain');
    await new Promise(resolve => setTimeout(resolve, 180));
    const snapshots = frames.filter(frame => frame.startsWith('event: snapshot'));
    assert.equal(snapshots.length, 2);
    assert.equal(JSON.parse(snapshots[1].match(/data: (.*)/)[1]).speed, 99);
    res.emit('close');
    assert.equal(telemetry.listenerCount('update'), 0); assert.equal(res.listenerCount('drain'), 0);
  } finally { res.emit('close'); store.db.close(); }
});

test('live admin counts track joins, disconnects, per-link isolation and revocation', { timeout: 8000 }, async () => {
  const f = await fixture(); const streams = [];
  try {
    const one = f.store.create('1', 'First', 1), two = f.store.create('1', 'Second', 1);
    const admin = await openStream(`${f.base}/admin/api/viewers/events`); streams.push(admin);
    assert.deepEqual((await admin.event()).data, {});
    assert.deepEqual(await admin.event(), { type: 'connection', data: { connected: true, configured: false } });
    const vehicles = await admin.event();
    assert.equal(vehicles.type, 'vehicles');
    assert.deepEqual(vehicles.data.map(car => car.name), ['Shared car', 'Private car']);
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
    f.telemetry.ingest('teslamate/cars/2/location', Buffer.from('{"latitude":40,"longitude":-74}'));
    const moved = await admin.event();
    assert.equal(moved.type, 'vehicles');
    assert.deepEqual(moved.data.find(car => car.id === '2').location, { latitude: 40, longitude: -74 });
    f.telemetry.ingest('teslamate/cars/2/state', Buffer.from('driving'));
    f.telemetry.ingest('teslamate/cars/2/speed', Buffer.from('99'));
    const driving = await admin.event();
    assert.equal(driving.type, 'vehicles');
    assert.deepEqual(driving.data.find(car => car.id === '2').speed, 99);
    assert.equal(driving.data.find(car => car.id === '2').speedFresh, true);
    f.telemetry.connected = false;
    assert.deepEqual(await admin.event(), { type: 'connection', data: { connected: false, configured: false } });
  } finally {
    for (const stream of streams) await stream.reader.cancel().catch(() => {});
    f.server.closeAllConnections(); await new Promise(resolve => f.server.close(resolve)); f.store.db.close();
  }
});
