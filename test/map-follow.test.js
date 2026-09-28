import test from 'node:test';
import assert from 'node:assert/strict';
import { followLocations } from '../public/map-follow.js';
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
