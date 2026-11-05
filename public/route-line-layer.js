const empty = () => ({ type: 'FeatureCollection', features: [] });
const sourceId = 'tesla-route-line';
const width = (far, middle, close) => ['interpolate', ['linear'], ['zoom'], 10, far, 15, middle, 19, close];
const layers = [
  { id: 'tesla-route-completed', filter: ['==', ['get', 'part'], 'completed'], paint: { 'line-color': '#87939d', 'line-width': width(3, 4.5, 6.5), 'line-opacity': 0.5 } },
  { id: 'tesla-route-casing', filter: ['==', ['get', 'part'], 'remaining'], paint: { 'line-color': '#114b91', 'line-width': width(6, 8.5, 14), 'line-opacity': 0.85 } },
  { id: 'tesla-route-remaining', filter: ['==', ['get', 'part'], 'remaining'], paint: { 'line-color': '#2685ef', 'line-width': width(4, 6, 11) } }
];
function rasterWidth(expression, zoom) {
  const stops = expression.slice(3);
  for (let i = 2; i < stops.length; i += 2) {
    if (zoom <= stops[i]) {
      const fraction = Math.max(0, (zoom - stops[i - 2]) / (stops[i] - stops[i - 2]));
      return stops[i - 1] + fraction * (stops[i + 1] - stops[i - 1]);
    }
  }
  return stops.at(-1);
}

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
          color: layer.paint['line-color'], weight: rasterWidth(layer.paint['line-width'], map.getZoom()), opacity: layer.paint['line-opacity'] ?? 1,
          lineCap: 'round', lineJoin: 'round', interactive: false
        }).addTo(map));
      }
      dirty = false;
    }
  }
  if (vector) {
    map.raw.on('style.load', () => { dirty = true; apply(); });
    map.raw.on('idle', apply);
  } else map.on('zoomend', () => { dirty = true; apply(); });
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
