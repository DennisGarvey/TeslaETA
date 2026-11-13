import test from 'node:test';
import assert from 'node:assert/strict';
import { followLocations, followFleetLocations } from '../public/map-follow.js';

class MapStub {
  constructor(options) { this.options = options; this.listeners = new Map(); this.fits = []; this.centers = []; this.styles = []; this.paints = []; }
  on(event, callback) {
    const listeners = this.listeners.get(event) || [];
    listeners.push(callback); this.listeners.set(event, listeners);
  }
  emit(event, data = {}) { for (const callback of this.listeners.get(event) || []) callback(data); }
  setStyle(style) { this.styles.push(style); this.style = style; }
  getLayer(id) { return typeof this.style === 'object' ? this.style.layers.find(layer => layer.id === id) : undefined; }
  setPaintProperty(id, property, value) { this.paints.push({ id, property, value }); }
  addControl() {}
  getContainer() { return { clientWidth: 900, clientHeight: 600, addEventListener() {}, removeEventListener() {} }; }
  getPitch() { return this.pitch ?? 0; }
  setPitch(pitch) { this.pitch = pitch; this.emit('movestart'); this.emit('pitchstart'); }
  fitBounds(bounds) { this.fits.push(bounds.points); this.emit('movestart'); this.emit('zoomstart'); }
  easeTo(options) { this.centers.push(options); this.emit('movestart'); this.emit('zoomstart'); }
  resize() { this.emit('movestart'); this.emit('resize'); this.emit('moveend'); }
}

class MarkerStub {
  constructor(options) { this.element = options.element; }
  setLngLat() { return this; }
  addTo(map) { map.marker = this; return this; }
  setOffset() { return this; }
  setRotationAlignment(alignment) { this.alignment = alignment; return this; }
  setPitchAlignment(alignment) { this.pitchAlignment = alignment; return this; }
}

async function withVectorMap(t) {
  const values = {
    window: { maplibregl: {
      Map: MapStub, Marker: MarkerStub, NavigationControl: class {}, AttributionControl: class {},
      LngLatBounds: class { constructor() { this.points = []; } extend(point) { this.points.push(point); } }
    }, matchMedia: () => ({ matches: true }) },
    document: { documentElement: { classList: { contains: () => false } }, addEventListener() {} },
    location: { origin: 'http://localhost', search: '' },
    MutationObserver: class { observe() {} },
    fetch: async () => ({ ok: false })
  };
  for (const [key, value] of Object.entries(values)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else delete globalThis[key];
    });
  }
  return import('../public/vector-map.js');
}

test('vector sharing tracking survives resize-generated movement but pauses for actual map input', async t => {
  const { createVectorMap } = await withVectorMap(t);
  const map = createVectorMap('map'), button = {};
  let points = [[40, -74], [41, -73]];
  const tracking = followLocations(map, () => points, points => map.fitBounds(points), button);
  tracking.update(); assert.equal(map.raw.fits.length, 1);
  map.raw.emit('moveend');
  map.invalidateSize();
  assert.equal(map.raw.fits.length, 2); assert.equal(button.hidden, true);
  // Some movement notifications can arrive after the resize event itself.
  map.raw.emit('movestart'); map.raw.emit('zoomstart');
  points = [[40.1, -74], [41, -73]]; tracking.update();
  assert.equal(map.raw.fits.length, 3);
  for (const [event, input] of [['dragstart', 'pointermove'], ['zoomstart', 'wheel'], ['zoomstart', 'touchmove'], ['movestart', 'keydown'], ['zoomstart', 'click']]) {
    // A person can interrupt an automatic fit before its animation finishes.
    map.raw.emit(event, { originalEvent: { type: input } });
    const fits = map.raw.fits.length;
    map.invalidateSize(); tracking.update();
    assert.equal(map.raw.fits.length, fits); assert.equal(button.hidden, false);
    button.onclick();
    assert.equal(map.raw.fits.length, fits + 1); assert.equal(button.hidden, true);
  }
  map.raw.pitch = 45;
  map.raw.emit('pitchstart', { originalEvent: { type: 'touchmove' } });
  assert.equal(button.hidden, false);
  button.onclick();
  assert.equal(map.raw.getPitch(), 0);
  assert.equal(button.hidden, true);
});

test('vector fleet tracking keeps its selected vehicle centered through window resizing', async t => {
  const { createVectorMap } = await withVectorMap(t);
  const map = createVectorMap('fleet-map'), button = {};
  const locations = new Map([['1', [40, -74]], ['2', [41, -73]]]);
  const tracking = followFleetLocations(map, () => [...locations.values()], id => locations.get(id),
    points => map.fitBounds(points), point => map.setView(point, 15), button, () => {});
  tracking.select('2'); assert.equal(map.raw.centers.length, 1);
  map.raw.emit('moveend'); map.invalidateSize();
  assert.equal(tracking.selected(), '2'); assert.equal(map.raw.centers.length, 2);
  locations.set('2', [41.1, -73]); tracking.update();
  assert.equal(map.raw.centers.length, 3);
  map.raw.emit('dragstart', { originalEvent: { type: 'touchmove' } });
  map.invalidateSize(); assert.equal(map.raw.centers.length, 3);
  map.raw.pitch = 45;
  button.onclick(); assert.equal(tracking.selected(), null);
  assert.equal(map.raw.getPitch(), 0);
  const fits = map.raw.fits.length;
  map.raw.emit('moveend'); map.invalidateSize();
  assert.equal(map.raw.fits.length, fits + 1); assert.equal(button.hidden, true);
});

test('theme changes use immediate paint updates without rebuilding the map or changing its camera', async t => {
  const { createVectorMap } = await withVectorMap(t);
  const observers = [];
  let dark = false;
  globalThis.document.documentElement.classList.contains = () => dark;
  globalThis.MutationObserver = class { constructor(callback) { observers.push(callback); } observe() {} };
  globalThis.fetch = async url => ({ ok: true, json: async () => ({
    version: 8, glyphs: '/fonts/{fontstack}/{range}.pbf', sprite: [], sources: {},
    layers: [{ id: 'background', type: 'background', paint: { 'background-color': url.includes('shadow') ? '#222222' : '#ffffff' } }]
  }) });
  const map = createVectorMap('map');
  await new Promise(resolve => setImmediate(resolve));
  dark = true; observers[0]();
  assert.equal(map.raw.options.fadeDuration, 0);
  assert.equal(map.raw.options.canvasContextAttributes, undefined);
  assert.deepEqual(map.raw.style.transition, { duration: 0, delay: 0 });
  const styleChanges = map.raw.styles.length;
  dark = false; observers[0]();
  dark = true; observers[0]();
  assert.equal(map.raw.styles.length, styleChanges);
  assert.deepEqual(map.raw.paints, [
    { id: 'background', property: 'background-color', value: '#ffffff' },
    { id: 'background', property: 'background-color', value: '#222222' }
  ]);
  assert.equal(map.raw.fits.length, 0); assert.equal(map.raw.centers.length, 0);
});

test('vehicle arrows follow map bearing and pitch while destination pins and fleet numbers stay upright', async t => {
  const { createVectorMap, vectorMarker } = await withVectorMap(t);
  globalThis.document.createElement = () => {
    const element = { style: {} };
    element.classList = { contains: name => element.className.split(' ').includes(name) };
    return element;
  };
  const map = createVectorMap('map');
  const icon = className => ({ options: { className, iconSize: [46, 46], html: '<svg></svg>' } });
  const marker = vectorMarker([40, -74], { icon: icon('vehicle-marker'), title: 'Vehicle' }, map);
  assert.equal(map.raw.marker.alignment, 'map');
  assert.equal(map.raw.marker.pitchAlignment, 'map');
  marker.setIcon(icon('destination-marker'));
  assert.equal(map.raw.marker.alignment, 'viewport');
  assert.equal(map.raw.marker.pitchAlignment, 'viewport');
  marker.setIcon(icon('fleet-number'));
  assert.equal(map.raw.marker.alignment, 'viewport');
  assert.equal(map.raw.marker.pitchAlignment, 'viewport');
  marker.setIcon(icon('vehicle-marker fleet-arrow'));
  assert.equal(map.raw.marker.alignment, 'map');
  assert.equal(map.raw.marker.pitchAlignment, 'map');
});

test('Safari trackpad twists and pinches share a fixed anchor and preserve touchscreen handling', async t => {
  const { enableTrackpadGestures } = await withVectorMap(t);
  const listeners = new Map(), moves = [];
  let cleanup, stopped = 0;
  const container = {
    getBoundingClientRect: () => ({ left: 20, top: 30 }),
    addEventListener: (name, listener) => listeners.set(name, listener),
    removeEventListener: name => listeners.delete(name)
  };
  enableTrackpadGestures({ getContainer: () => container, stop: () => stopped++,
    getBearing: () => 30, getZoom: () => 10, unproject: point => point,
    easeTo: (options, data) => moves.push({ options, data }), on: (_, fn) => { cleanup = fn; } });
  const gesture = (name, extra = {}) => {
    const event = { clientX: 120, clientY: 230, rotation: 0, scale: 1,
      preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...extra };
    listeners.get(name)(event); return event;
  };
  gesture('gesturestart');
  assert.equal(stopped, 1);
  const change = gesture('gesturechange', { rotation: 45, scale: 2 });
  assert.deepEqual(moves[0].options, { bearing: -15, zoom: 11, around: [100, 200], duration: 0 });
  assert.equal(moves[0].data.originalEvent, change);
  gesture('gesturechange', { rotation: 90, scale: 0.5 });
  assert.equal(moves[1].options.bearing, -60);
  assert.equal(moves[1].options.zoom, 9);
  assert.equal(gesture('wheel', { ctrlKey: true }).stopped, true);
  gesture('gestureend');
  assert.equal(gesture('wheel', { ctrlKey: true }).stopped, undefined);
  gesture('touchstart', { touches: [{}, {}] });
  assert.equal(gesture('gesturestart').prevented, undefined);
  gesture('gesturechange', { rotation: 20 });
  assert.equal(moves.length, 2);
  gesture('touchend', { touches: [] });
  gesture('gesturestart');
  gesture('gesturechange', { scale: 0 });
  assert.equal(moves.length, 2);
  cleanup(); assert.equal(listeners.size, 0);
});
