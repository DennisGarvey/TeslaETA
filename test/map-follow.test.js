import test from 'node:test';
import assert from 'node:assert/strict';
import { followLocations, followFleetLocations, safeFitPadding } from '../public/map-follow.js';
test('fit padding leaves room for markers and controls on desktop and compact maps', () => {
  assert.deepEqual(safeFitPadding({ x: 900, y: 600 }), { paddingTopLeft: [72, 84], paddingBottomRight: [88, 56] });
  assert.deepEqual(safeFitPadding({ x: 390, y: 140 }), { paddingTopLeft: [72, 49], paddingBottomRight: [88, 35] });
});
test('fits updated locations, preserves user pan/zoom, and resumes on recenter', () => {
  const listeners = new Map();
  const map = { on(events, fn) { for (const event of events.split(' ')) listeners.set(event, fn); } };
  const button = { setAttribute() {} };
  let points = [[40, -74], [41, -73]], calls = 0;
  const controller = followLocations(map, () => points, () => {
    calls++; listeners.get('movestart')(); listeners.get('zoomstart')();
  }, button);
  assert.equal(button.hidden, true);
  controller.update(); assert.equal(calls, 1);
  controller.update(); assert.equal(calls, 1);
  points = [[40.1, -74], [41, -73]];
  controller.update(); assert.equal(calls, 2);
  listeners.get('dragstart')(); points = [[40.2, -74], [41, -73]];
  controller.update(); assert.equal(calls, 2);
  assert.equal(button.textContent, 'Recenter');
  assert.equal(button.hidden, false);
  button.onclick(); assert.equal(calls, 3);
  assert.equal(button.hidden, true);
  points = [[40.3, -74]]; controller.update(); assert.equal(calls, 4);
  listeners.get('zoomstart')(); points = [[40.4, -74]];
  controller.update(); assert.equal(calls, 4);
  button.onclick(); assert.equal(calls, 5);
  listeners.get('resize')(); assert.equal(calls, 6);
});
test('fleet selection follows one vehicle and show all restores fleet tracking', () => {
  const listeners = new Map();
  const map = { on(events, fn) { for (const event of events.split(' ')) listeners.set(event, fn); } };
  const button = {};
  const locations = new Map([['1', [40, -74]], ['2', [41, -73]]]);
  const calls = [], selections = [];
  const tracking = followFleetLocations(map, () => [...locations.values()], id => locations.get(id),
    points => { calls.push(['all', points]); listeners.get('movestart')(); },
    (point, force) => { calls.push(['selected', point, force]); listeners.get('zoomstart')(); },
    button, id => selections.push(id));
  tracking.update();
  assert.deepEqual(calls.at(-1), ['all', [[40, -74], [41, -73]]]);
  tracking.select('2');
  assert.equal(tracking.selected(), '2');
  assert.deepEqual(calls.at(-1), ['selected', [41, -73], true]);
  assert.equal(button.textContent, 'Show all vehicles');
  assert.equal(button.hidden, false);
  locations.set('2', [41.1, -73]); tracking.update();
  assert.deepEqual(calls.at(-1), ['selected', [41.1, -73], false]);
  listeners.get('dragstart')(); locations.set('2', [41.2, -73]); tracking.update();
  assert.equal(calls.length, 3);
  tracking.select('2');
  assert.deepEqual(calls.at(-1), ['selected', [41.2, -73], true]);
  button.onclick();
  assert.equal(tracking.selected(), null);
  assert.equal(button.hidden, true);
  assert.deepEqual(calls.at(-1), ['all', [[40, -74], [41.2, -73]]]);
  tracking.select('2'); locations.delete('2'); tracking.update();
  assert.equal(tracking.selected(), null);
  assert.deepEqual(selections.at(-1), null);
  assert.deepEqual(calls.at(-1), ['all', [[40, -74]]]);
});
