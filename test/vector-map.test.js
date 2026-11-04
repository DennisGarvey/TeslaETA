import test from 'node:test';
import assert from 'node:assert/strict';
import { followLocations, followFleetLocations } from '../public/map-follow.js';

class MapStub {
  constructor() { this.listeners = new Map(); this.fits = []; this.centers = []; }
  on(event, callback) {
    const listeners = this.listeners.get(event) || [];
    listeners.push(callback); this.listeners.set(event, listeners);
  }
  emit(event, data = {}) { for (const callback of this.listeners.get(event) || []) callback(data); }
  setStyle() {}
  addControl() {}
  getContainer() { return { clientWidth: 900, clientHeight: 600 }; }
  fitBounds(bounds) { this.fits.push(bounds.points); this.emit('movestart'); this.emit('zoomstart'); }
  easeTo(options) { this.centers.push(options); this.emit('movestart'); this.emit('zoomstart'); }
  resize() { this.emit('movestart'); this.emit('resize'); this.emit('moveend'); }
}

async function withVectorMap(t) {
  const values = {
    window: { maplibregl: {
      Map: MapStub, NavigationControl: class {}, AttributionControl: class {},
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
  button.onclick(); assert.equal(tracking.selected(), null);
  const fits = map.raw.fits.length;
  map.raw.emit('moveend'); map.invalidateSize();
  assert.equal(map.raw.fits.length, fits + 1); assert.equal(button.hidden, true);
});
