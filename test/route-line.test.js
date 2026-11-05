import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeRouteLine, RouteProgress, routeLineMaxBytes } from '../public/route-line.js';
import { createRouteLineLayer } from '../public/route-line-layer.js';
import { followLocations } from '../public/map-follow.js';
import { Telemetry } from '../server/telemetry.js';

function encode(points) {
  let previous = [0, 0], result = '';
  for (const point of points) {
    point.forEach((value, index) => {
      const rounded = Math.round(value * 1e6), delta = rounded - previous[index];
      previous[index] = rounded;
      let encoded = delta < 0 ? -delta * 2 - 1 : delta * 2;
      while (encoded >= 32) { result += String.fromCharCode((encoded % 32) + 95); encoded = Math.floor(encoded / 32); }
      result += String.fromCharCode(encoded + 63);
    });
  }
  return Buffer.from(result).toString('base64');
}

const points = [[40, -74], [40, -73.98], [40.01, -73.98], [40.01, -74], [40.02, -74]];
const line = encode(points);
const closePoint = (a, b) => a.forEach((value, index) => assert.ok(Math.abs(value - b[index]) < 1e-6, `${a} != ${b}`));

test('base64 polyline decoding uses precision six and rejects malformed, oversized or out-of-range data', () => {
  const googleExample = Buffer.from('_p~iF~ps|U_ulLnnqC_mqNvxq`@').toString('base64');
  assert.deepEqual(decodeRouteLine(googleExample), [[3.85, -12.02], [4.07, -12.095], [4.3252, -12.6453]]);
  assert.deepEqual(decodeRouteLine(line), points);
  assert.deepEqual(decodeRouteLine(line.replace(/=+$/, '')), points);
  for (const value of [null, {}, '', 'invalid%base64', 'a', 'A===', Buffer.from('???').toString('base64'), Buffer.from('~~~~~~~').toString('base64'), Buffer.from('\0\0\0\0').toString('base64'), encode([[91, 0], [91, 1]]), encode([[0, 181], [0, 180]]), encode([[0, 0]]), 'A'.repeat(routeLineMaxBytes + 1), encode(Array.from({ length: 50001 }, () => [0, 0]))]) {
    assert.equal(decodeRouteLine(value), null);
  }
});

test('protobuf-wrapped RouteLine extracts the polyline and safely skips additional fields', () => {
  const polyline = Buffer.from(line, 'base64');
  const field = Buffer.concat([Buffer.from([0x0a, polyline.length]), polyline]);
  const metadata = Buffer.from([0x12, 3, 8, 1, 16, 0x18, 0x80, 0x01, 0x21, 0, 0, 0, 0, 0, 0, 0, 0, 0x2d, 0, 0, 0, 0]);
  assert.deepEqual(decodeRouteLine(Buffer.concat([field, metadata]).toString('base64')), points);
  const long = Buffer.from(encode(Array.from({ length: 200 }, (_, index) => [40 + index / 10000, -74])), 'base64');
  const longField = Buffer.concat([Buffer.from([0x0a, (long.length & 127) | 128, long.length >> 7]), long]);
  assert.equal(decodeRouteLine(longField.toString('base64')).length, 200);
  for (const malformed of [field.subarray(0, -1), Buffer.concat([field, field]), Buffer.concat([field, Buffer.from([0x12, 5, 1])]), Buffer.from([0x0a, 0xff, 0xff, 0xff, 0xff, 0x7f]), Buffer.from([0x08, 1]), Buffer.from([0x12, 1, 63]), Buffer.concat([field, Buffer.from([0x21, 0])])]) {
    assert.equal(decodeRouteLine(malformed.toString('base64')), null);
  }
  const telemetry = new Telemetry();
  const wrapped = Buffer.concat([field, metadata]).toString('base64');
  telemetry.ingest('teslamate/cars/5/route_line', Buffer.from(wrapped));
  assert.equal(telemetry.snapshot('5').routeLine, wrapped);
});

test('optional route topic accepts raw or JSON strings, remains scoped to its car, and survives unchanged-route telemetry', () => {
  const telemetry = new Telemetry(); telemetry.connected = true;
  assert.equal(telemetry.snapshot('1').routeLine, undefined);
  telemetry.ingest('teslamate/cars/1/route_line', Buffer.from(line), true, 1000);
  telemetry.ingest('teslamate/cars/2/RouteLine', Buffer.from(JSON.stringify(line)), false, 1000);
  assert.equal(telemetry.snapshot('1', 1001).routeLine, line);
  assert.equal(telemetry.snapshot('2', 1001).routeLine, line);
  telemetry.ingest('teslamate/cars/1/active_route', Buffer.from(JSON.stringify({ location: { latitude: 40.02, longitude: -74 }, minutes_to_arrival: 10 })), false, 2000);
  assert.equal(telemetry.snapshot('1', 300000).routeLine, line);
  telemetry.ingest('teslamate/cars/1/route_line', Buffer.from('malformed'), false, 300001);
  assert.equal(telemetry.snapshot('1').routeLine, line);
  assert.equal(telemetry.snapshot('2').routeLine, line);
  const large = encode(Array.from({ length: 10000 }, (_, index) => [40 + index / 1e6, -74 + index / 1e6]));
  assert.ok(large.length > 16384);
  telemetry.ingest('teslamate/cars/3/route_line', Buffer.from(large));
  assert.equal(telemetry.snapshot('3').routeLine, large);
});

test('RouteLine waits for delayed TeslaMate destinations without discarding geometry', () => {
  const telemetry = new Telemetry();
  const navigation = destination => Buffer.from(JSON.stringify({ location: { latitude: destination[0], longitude: destination[1] } }));
  telemetry.ingest('teslamate/cars/1/route_line', Buffer.from(line));
  telemetry.ingest('teslamate/cars/1/active_route', navigation(points.at(-1)));
  assert.equal(telemetry.snapshot('1').routeLine, line);
  telemetry.ingest('teslamate/cars/1/active_route', navigation([41, -75]));
  assert.equal(telemetry.snapshot('1').routeLine, null);
  const rerouted = encode([[40, -74], [41, -75]]);
  telemetry.ingest('teslamate/cars/1/route_line', Buffer.from(rerouted));
  assert.equal(telemetry.snapshot('1').routeLine, rerouted);
  telemetry.ingest('teslamate/cars/1/active_route', Buffer.from('{"error":"No active route available"}'));
  assert.equal(telemetry.snapshot('1').routeLine, null);
  telemetry.ingest('teslamate/cars/1/active_route', navigation([41, -75]));
  assert.equal(telemetry.snapshot('1').routeLine, rerouted);
  telemetry.ingest('teslamate/cars/1/route_line', Buffer.alloc(0));
  assert.equal(telemetry.snapshot('1').routeLine, rerouted);
  telemetry.ingest('teslamate/cars/1/active_route', Buffer.from('{"error":"No active route available"}'));
  assert.equal(telemetry.snapshot('1').routeLine, null);
  telemetry.ingest('teslamate/cars/1/route_line', Buffer.from(line));
  telemetry.ingest('teslamate/cars/1/route_line', Buffer.from(Buffer.from([0x12, 0]).toString('base64')));
  assert.equal(telemetry.snapshot('1').routeLine, null);
  telemetry.ingest('teslamate/cars/1/active_route', navigation(points.at(-1)));
  assert.equal(telemetry.snapshot('1').routeLine, null);
});

test('a RouteLine arriving after an inactive retained destination appears when TeslaMate catches up', () => {
  const telemetry = new Telemetry();
  telemetry.ingest('teslamate/cars/1/active_route', Buffer.from('{"error":"No active route available"}'), true);
  telemetry.ingest('teslamate/cars/1/route_line', Buffer.from(line));
  assert.equal(telemetry.snapshot('1').routeLine, null);
  telemetry.ingest('teslamate/cars/1/active_route', Buffer.from(JSON.stringify({ location: { latitude: points.at(-1)[0], longitude: points.at(-1)[1] } })));
  assert.equal(telemetry.snapshot('1').routeLine, line);
});

test('a replacement line keeps the previous matching line visible, while same-destination reroutes update immediately', () => {
  const telemetry = new Telemetry();
  const topic = 'teslamate/cars/1/';
  const navigation = point => Buffer.from(JSON.stringify({ location: { latitude: point[0], longitude: point[1] } }));
  telemetry.ingest(topic + 'active_route', navigation(points.at(-1)));
  telemetry.ingest(topic + 'route_line', Buffer.from(line));
  const rerouted = encode([[40, -74], [40.03, -73.96], points.at(-1)]);
  telemetry.ingest(topic + 'route_line', Buffer.from(rerouted));
  assert.equal(telemetry.snapshot('1').routeLine, rerouted);
  const newDestination = [41, -75], replacement = encode([[40, -74], newDestination]);
  telemetry.ingest(topic + 'route_line', Buffer.from(replacement));
  assert.equal(telemetry.snapshot('1').routeLine, rerouted);
  telemetry.ingest(topic + 'active_route', navigation(points.at(-1)));
  assert.equal(telemetry.snapshot('1').routeLine, rerouted);
  telemetry.ingest(topic + 'active_route', navigation(newDestination));
  assert.equal(telemetry.snapshot('1').routeLine, replacement);
  telemetry.ingest(topic + 'route_line', Buffer.alloc(0));
  assert.equal(telemetry.snapshot('1').routeLine, replacement);
  telemetry.ingest(topic + 'active_route', navigation(newDestination));
  assert.equal(telemetry.snapshot('1').routeLine, replacement);
  telemetry.ingest(topic + 'active_route', Buffer.from('{"error":"No active route available"}'));
  assert.equal(telemetry.snapshot('1').routeLine, null);
});

test('nearby changed route endpoints wait for metadata even when both routes end near an offset pin', () => {
  const telemetry = new Telemetry(), topic = 'teslamate/cars/1/';
  const oldPin = [40.02, -74], oldEnd = [40.021, -74], newEnd = [40.0203, -74];
  const oldLine = encode([[40, -74], oldEnd]);
  const newLine = encode([[40, -74], newEnd]);
  const navigation = (pin, name) => Buffer.from(JSON.stringify({ location: { latitude: pin[0], longitude: pin[1] }, destination: name }));
  telemetry.ingest(topic + 'active_route', navigation(oldPin, 'Old'));
  telemetry.ingest(topic + 'route_line', Buffer.from(oldLine));
  assert.equal(telemetry.snapshot('1').routeLine, oldLine);
  // The replacement is even closer to the old pin, but has a different road endpoint.
  telemetry.ingest(topic + 'route_line', Buffer.from(newLine));
  assert.equal(telemetry.snapshot('1').routeLine, oldLine);
  telemetry.ingest(topic + 'active_route', navigation(oldPin, 'Old'));
  assert.equal(telemetry.snapshot('1').routeLine, oldLine);
  const newPin = [40.0203, -73.999];
  telemetry.ingest(topic + 'active_route', navigation(newPin, 'New'));
  assert.equal(telemetry.snapshot('1').routeLine, newLine);
  assert.deepEqual(telemetry.snapshot('1').route.location, { latitude: newPin[0], longitude: newPin[1] });
  const reroute = encode([[40, -74], [40.01, -73.99], newEnd]);
  telemetry.ingest(topic + 'route_line', Buffer.from(reroute));
  assert.equal(telemetry.snapshot('1').routeLine, reroute);
});

test('a pending line is pushed after ten seconds without moving the TeslaMate pin', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const telemetry = new Telemetry(), topic = 'teslamate/cars/1/';
  const active = point => Buffer.from(JSON.stringify({ location: { latitude: point[0], longitude: point[1] } }));
  const replacement = encode([[40, -74], [41, -75]]);
  telemetry.ingest(topic + 'active_route', active(points.at(-1)));
  telemetry.ingest(topic + 'route_line', Buffer.from(line));
  telemetry.ingest(topic + 'route_line', Buffer.from(replacement));
  t.mock.timers.tick(9000);
  // Duplicate route and destination messages must not postpone the deadline.
  telemetry.ingest(topic + 'route_line', Buffer.from(replacement));
  telemetry.ingest(topic + 'active_route', active(points.at(-1)));
  t.mock.timers.tick(999);
  assert.equal(telemetry.snapshot('1').routeLine, line);
  let pushed = 0;
  telemetry.on('update', id => { if (id === '1') pushed++; });
  t.mock.timers.tick(1);
  assert.equal(pushed, 1);
  assert.equal(telemetry.snapshot('1').routeLine, replacement);
  assert.deepEqual(telemetry.snapshot('1').route.location, { latitude: 40.02, longitude: -74 });
  telemetry.ingest(topic + 'active_route', active(points.at(-1)));
  assert.equal(telemetry.snapshot('1').routeLine, replacement);
  telemetry.ingest(topic + 'active_route', active([41, -75]));
  assert.equal(telemetry.snapshot('1').routeLine, replacement);
});

test('pending timers are replaced by new geometry and cancelled by metadata or a clear', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const telemetry = new Telemetry(), topic = 'teslamate/cars/1/';
  const active = point => Buffer.from(JSON.stringify({ location: { latitude: point[0], longitude: point[1] } }));
  const replacement = encode([[40, -74], [41, -75]]);
  const latest = encode([[40, -74], [42, -76]]);
  telemetry.ingest(topic + 'active_route', active(points.at(-1)));
  telemetry.ingest(topic + 'route_line', Buffer.from(line));
  telemetry.ingest(topic + 'route_line', Buffer.from(replacement));
  t.mock.timers.tick(5000);
  telemetry.ingest(topic + 'route_line', Buffer.from(latest));
  t.mock.timers.tick(5000);
  assert.equal(telemetry.snapshot('1').routeLine, line);
  telemetry.ingest(topic + 'active_route', active([42, -76]));
  assert.equal(telemetry.snapshot('1').routeLine, latest);
  let pushed = 0;
  telemetry.on('update', () => pushed++);
  t.mock.timers.tick(10000);
  assert.equal(pushed, 0);
  telemetry.ingest(topic + 'route_line', Buffer.from(replacement));
  telemetry.ingest(topic + 'route_line', Buffer.alloc(0));
  const count = pushed;
  t.mock.timers.tick(10000);
  assert.equal(pushed, count);
  assert.equal(telemetry.snapshot('1').routeLine, latest);
});

test('a nearby destination arriving first does not bind the old line to the new destination', () => {
  const telemetry = new Telemetry(), topic = 'teslamate/cars/1/';
  const active = point => Buffer.from(JSON.stringify({ location: { latitude: point[0], longitude: point[1] } }));
  const oldEnd = [40.02, -74], newEnd = [40.021, -74];
  const oldLine = encode([[40, -74], oldEnd]), replacement = encode([[40, -74], newEnd]);
  telemetry.ingest(topic + 'active_route', active(oldEnd));
  telemetry.ingest(topic + 'route_line', Buffer.from(oldLine));
  telemetry.ingest(topic + 'active_route', active(newEnd));
  assert.equal(telemetry.snapshot('1').routeLine, null);
  telemetry.ingest(topic + 'route_line', Buffer.from(replacement));
  assert.equal(telemetry.snapshot('1').routeLine, replacement);
});

test('route clearing stays synchronized for either message order and does not resurrect cleared geometry', () => {
  const active = Buffer.from(JSON.stringify({ location: { latitude: points.at(-1)[0], longitude: points.at(-1)[1] } }));
  const inactive = Buffer.from('{"error":"No active route available"}');
  for (const clear of [Buffer.alloc(0), Buffer.from(Buffer.from([0x12, 0]).toString('base64'))]) {
    for (const lineFirst of [true, false]) {
      const telemetry = new Telemetry();
      telemetry.ingest('teslamate/cars/1/active_route', active);
      telemetry.ingest('teslamate/cars/1/route_line', Buffer.from(line));
      if (lineFirst) {
        telemetry.ingest('teslamate/cars/1/route_line', clear);
        assert.equal(telemetry.snapshot('1').routeLine, line);
        telemetry.ingest('teslamate/cars/1/active_route', active);
        assert.equal(telemetry.snapshot('1').routeLine, line);
        telemetry.ingest('teslamate/cars/1/active_route', inactive);
      } else {
        telemetry.ingest('teslamate/cars/1/active_route', inactive);
        assert.equal(telemetry.snapshot('1').routeLine, null);
        telemetry.ingest('teslamate/cars/1/route_line', clear);
      }
      assert.equal(telemetry.snapshot('1').routeLine, null);
      assert.equal(telemetry.snapshot('1').route, null);
      telemetry.ingest('teslamate/cars/1/active_route', active);
      assert.equal(telemetry.snapshot('1').routeLine, null);
    }
  }
});

test('RouteLine-only sources still clear immediately when no TeslaMate navigation metadata exists', () => {
  const telemetry = new Telemetry();
  telemetry.ingest('teslamate/cars/1/route_line', Buffer.from(line));
  assert.equal(telemetry.snapshot('1').routeLine, line);
  telemetry.ingest('teslamate/cars/1/route_line', Buffer.alloc(0));
  assert.equal(telemetry.snapshot('1').routeLine, null);
});

test('initial route progress ignores remaining distance belonging to an older destination', () => {
  const loop = [[40, -74], [40, -73.99], [40.01, -73.99], [40.01, -74], [40, -74], [40, -73.98]];
  const encoded = encode(loop);
  const unrelated = new RouteProgress().update(encoded, loop[0], { remainingMiles: 0.1, destination: [41, -75] });
  assert.equal(unrelated.completed.length, 0);
  assert.equal(unrelated.remaining.length, loop.length);
  const matching = new RouteProgress().update(encoded, loop[0], { remainingMiles: 1, destination: loop.at(-1) });
  assert.ok(matching.remaining.length < loop.length);
});

test('auto-fit includes bends ahead, lets completed segments leave the view, and preserves manual map movement', () => {
  const progress = new RouteProgress(), listeners = new Map(), calls = [], button = {};
  let view, car = points[0];
  const map = { on(events, callback) { for (const event of events.split(' ')) listeners.set(event, callback); } };
  const tracking = followLocations(map, () => [...(view?.remaining || []), car, points.at(-1)], fit => calls.push(fit), button);
  view = progress.update(line, car, { timestamp: 1000 }); tracking.update();
  assert.ok(calls.at(-1).some(point => point[1] === -73.98));
  car = points[3]; view = progress.update(line, car, { timestamp: 601000 }); tracking.update();
  assert.ok(calls.at(-1).every(point => Math.abs(point[1] + 74) < 1e-6));
  assert.ok(view.completed.some(point => point[1] === -73.98));
  const count = calls.length;
  listeners.get('dragstart')();
  car = [40.015, -74]; view = progress.update(line, car); tracking.update();
  assert.equal(calls.length, count);
  assert.equal(button.hidden, false);
  button.onclick();
  assert.equal(calls.length, count + 1);
  closePoint(calls.at(-1)[0], car);
  assert.equal(button.hidden, true);
  assert.equal(progress.update(null, car), null);
});

test('progress handles loops, duplicate points, GPS jitter, off-route locations, arrival and reroutes', () => {
  const progress = new RouteProgress();
  const loop = [[40, -74], [40, -73.99], [40.01, -73.99], [40.01, -74], [40, -74], [40, -73.98]];
  const encoded = encode(loop);
  progress.update(encoded, loop[0], { heading: 90 });
  let view = progress.update(encoded, [40, -73.995], { heading: 90 });
  assert.equal(view.remaining.length, 6);
  const before = view.remaining[0];
  view = progress.update(encoded, [40, -73.99501]);
  closePoint(view.remaining[0], before);
  view = progress.update(encoded, [41, -75]);
  closePoint(view.remaining[0], before);
  for (const point of loop.slice(1, 5)) view = progress.update(encoded, point);
  assert.ok(view.remaining.length <= 3);
  view = progress.update(encoded, [40, -73.995], { heading: 90 });
  assert.equal(view.remaining.length, 2);
  closePoint(view.remaining[0], [40, -73.995]);
  view = progress.update(encoded, loop.at(-1));
  closePoint(view.remaining[0], loop.at(-1));
  view = progress.update(line, points[0]);
  assert.equal(view.completed.length, 0);
  assert.deepEqual(view.remaining, points);
  const duplicate = encode([[40, -74], [40, -74], [40.01, -74]]);
  view = progress.update(duplicate, [40.005, -74]);
  closePoint(view.remaining[0], [40.005, -74]);
  assert.equal(progress.update(duplicate, [40.005, -74]), view);
  assert.equal(progress.update('invalid', [40.005, -74]), null);
});

test('date-line routes stay in one continuous map world', () => {
  const progress = new RouteProgress();
  const view = progress.update(encode([[10, 179.9], [10, -179.9], [10.1, -179.8]]), [10, -179.95]);
  assert.ok(Math.max(...view.remaining.map(point => point[1])) - Math.min(...view.remaining.map(point => point[1])) < 1);
});

test('vector route layers wait for the style, update once, survive style replacement, and clear silently', () => {
  const events = {}, sources = new Map(), rendered = new Map(), updates = [];
  let loaded = false;
  const raw = {
    on(event, callback) { events[event] = callback; }, isStyleLoaded: () => loaded,
    getSource: id => sources.get(id), addSource(id) { sources.set(id, { setData: data => updates.push(data) }); },
    getStyle: () => ({ layers: [{ id: 'labels', type: 'symbol' }] }), getLayer: id => rendered.get(id),
    addLayer(layer, before) { assert.equal(before, 'labels'); rendered.set(layer.id, layer); }
  };
  const layer = createRouteLineLayer({ raw }, true);
  const view = new RouteProgress().update(line, points[1]);
  layer.update(view); assert.equal(updates.length, 0);
  loaded = true; events['style.load']();
  assert.equal(rendered.size, 3);
  assert.deepEqual(rendered.get('tesla-route-remaining').paint['line-width'], ['interpolate', ['linear'], ['zoom'], 10, 4, 15, 6, 19, 9]);
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].features.find(feature => feature.properties.part === 'remaining').geometry.coordinates[0], [-73.98, 40]);
  layer.update(view); events.idle(); assert.equal(updates.length, 1);
  rendered.clear(); sources.clear(); events['style.load']();
  assert.equal(rendered.size, 3); assert.equal(updates.length, 2);
  layer.update(null); assert.deepEqual(updates.at(-1).features, []);
});

test('raster fallback displays and removes the same remaining and completed geometry', () => {
  const rendered = [], removed = [];
  let zoom = 10, onZoom;
  const leaflet = { polyline(points, options) {
    const layer = { addTo() { rendered.push({ points, options }); return layer; }, remove() { removed.push(layer); } };
    return layer;
  } };
  const layer = createRouteLineLayer({ getZoom: () => zoom, on: (event, callback) => { assert.equal(event, 'zoomend'); onZoom = callback; } }, false, leaflet);
  layer.update(new RouteProgress().update(line, points[1]));
  assert.equal(rendered.length, 3);
  closePoint(rendered.at(-1).points[0], points[1]);
  assert.equal(rendered.at(-1).options.interactive, false);
  assert.equal(rendered.at(-1).options.weight, 4);
  zoom = 17; onZoom(); assert.equal(rendered.at(-1).options.weight, 7.5);
  zoom = 19; onZoom(); assert.equal(rendered.at(-1).options.weight, 9);
  zoom = 22; onZoom(); assert.equal(rendered.at(-1).options.weight, 9);
  layer.update(null); assert.equal(removed.length, 12);
});
