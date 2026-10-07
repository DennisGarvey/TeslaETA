import test from 'node:test';
import assert from 'node:assert/strict';
import { Telemetry } from '../server/telemetry.js';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';

test('vector styles and sprites are served locally while map tiles stay on OSM', async () => {
  const store = new Store(':memory:');
  const server = createApp({ telemetry: new Telemetry(), store, config: { localPreview: true } }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const styles = {};
    for (const name of ['colorful', 'shadow', 'eclipse']) {
      const response = await fetch(`${base}/assets/map-styles/${name}.json`);
      assert.equal(response.status, 200);
      const style = await response.json();
      styles[name] = style;
      assert.equal(style.glyphs, '/assets/map-fonts/{fontstack}/{range}.pbf');
      assert.equal(style.sprite[0].url, '/assets/map-sprites/basics/sprites');
      assert.match(style.sources['versatiles-shortbread'].tiles[0], /^https:\/\/vector\.openstreetmap\.org\/shortbread_v1\//);
    }
    const layerStructure = style => style.layers.map(({ paint, ...layer }) => ({
      ...layer, paintKeys: Object.keys(paint || {}).sort()
    }));
    for (const name of ['shadow', 'eclipse']) {
      assert.deepEqual(styles[name].sources, styles.colorful.sources);
      assert.deepEqual(layerStructure(styles[name]), layerStructure(styles.colorful));
    }
    for (const suffix of ['.json', '.png', '@2x.json', '@2x.png']) {
      assert.equal((await fetch(`${base}/assets/map-sprites/basics/sprites${suffix}`)).status, 200);
    }
    assert.equal((await fetch(`${base}/assets/map-fonts/other/0-255.pbf`)).status, 404);
    assert.equal((await fetch(`${base}/assets/map-fonts/noto_sans_regular/1-256.pbf`)).status, 404);
  } finally {
    await new Promise(resolve => server.close(resolve));
    store.db.close();
  }
});
