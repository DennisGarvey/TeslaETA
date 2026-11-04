const empty = () => ({ type: 'FeatureCollection', features: [] });
const sourceId = 'tesla-route-line';
const layers = [
  { id: 'tesla-route-completed', filter: ['==', ['get', 'part'], 'completed'], paint: { 'line-color': '#87939d', 'line-width': 4, 'line-opacity': 0.5 } },
  { id: 'tesla-route-casing', filter: ['==', ['get', 'part'], 'remaining'], paint: { 'line-color': '#114b91', 'line-width': 7, 'line-opacity': 0.85 } },
  { id: 'tesla-route-remaining', filter: ['==', ['get', 'part'], 'remaining'], paint: { 'line-color': '#2685ef', 'line-width': 4.5 } }
];

export function createRouteLineLayer(map, vector, leaflet = globalThis.L) {
  let previous, geometry = empty(), dirty = false;
  const rasterLayers = [];
  function apply() {
    if (!dirty) return;
    if (vector) {
      const raw = map.raw;
      if (!raw.isStyleLoaded()) return;
      if (!raw.getSource(sourceId) && !geometry.features.length) { dirty = false; return; }
      if (!raw.getSource(sourceId)) raw.addSource(sourceId, { type: 'geojson', data: empty() });
      const before = raw.getStyle().layers.find(layer => layer.type === 'symbol')?.id;
      for (const layer of layers) if (!raw.getLayer(layer.id)) raw.addLayer({ ...layer, type: 'line', source: sourceId, layout: { 'line-cap': 'round', 'line-join': 'round' } }, before);
      dirty = false;
      raw.getSource(sourceId).setData(geometry);
    } else {
      for (const layer of rasterLayers) layer.remove();
      rasterLayers.length = 0;
      for (const layer of layers) {
        const feature = geometry.features.find(feature => feature.properties.part === layer.filter[2]);
        if (!feature) continue;
        rasterLayers.push(leaflet.polyline(feature.geometry.coordinates.map(([lng, lat]) => [lat, lng]), {
          color: layer.paint['line-color'], weight: layer.paint['line-width'], opacity: layer.paint['line-opacity'] ?? 1,
          lineCap: 'round', lineJoin: 'round', interactive: false
        }).addTo(map));
      }
      dirty = false;
    }
  }
  if (vector) {
    map.raw.on('style.load', () => { dirty = true; apply(); });
    map.raw.on('idle', apply);
  }
  return {
    update(view) {
      if (view === previous) return;
      previous = view;
      geometry = { type: 'FeatureCollection', features: Object.entries(view || {}).filter(([, points]) => points.length >= 2).map(([part, points]) => ({
        type: 'Feature', properties: { part }, geometry: { type: 'LineString', coordinates: points.map(([lat, lng]) => [lng, lat]) }
      })) };
      dirty = true;
      apply();
    }
  };
}
