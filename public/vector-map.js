const maplibregl = window.maplibregl;

const lightStyle = '/assets/map-styles/colorful.json';
const darkPalette = new URLSearchParams(location.search).get('dark') === 'eclipse' ? 'eclipse' : 'shadow';
const darkStyle = `/assets/map-styles/${darkPalette}.json`;
const latLng = point => [point[1], point[0]];
const absoluteStyleAssets = (_, style) => ({
  ...style,
  glyphs: `${location.origin}${style.glyphs}`,
  sprite: style.sprite.map(sprite => ({ ...sprite, url: `${location.origin}${sprite.url}` }))
});

export function vectorMapEnabled() {
  return new URLSearchParams(location.search).get('map') !== 'raster';
}

export function createVectorMap(container) {
  const dark = () => document.documentElement.classList.contains('theme-dark');
  const map = new maplibregl.Map({
    container, style: { version: 8, sources: {}, layers: [] },
    center: [-98, 39], zoom: 4, maxZoom: 19,
    attributionControl: false
  });
  const setStyle = url => map.setStyle(url, { transformStyle: absoluteStyleAssets });
  setStyle(dark() ? darkStyle : lightStyle);
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
  let priorDark = dark();
  const observer = new MutationObserver(() => {
    const nextDark = dark();
    if (nextDark !== priorDark) { priorDark = nextDark; setStyle(nextDark ? darkStyle : lightStyle); }
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

  // Tracking listens to camera-start events. Suppress those raised by our own fits.
  let movingByCode = false;
  map.on('moveend', () => { movingByCode = false; });
  const move = options => { movingByCode = true; map.easeTo({ ...options, duration: 350 }); };
  return {
    raw: map,
    on(events, callback) {
      for (const event of events.split(' ')) map.on(event, (...args) => {
        if (!movingByCode || event === 'resize') callback(...args);
      });
      return this;
    },
    getSize() { return { x: map.getContainer().clientWidth, y: map.getContainer().clientHeight }; },
    getZoom() { return map.getZoom(); },
    invalidateSize() { map.resize(); },
    fitBounds(points, options = {}) {
      const { paddingTopLeft = [0, 0], paddingBottomRight = [0, 0], maxZoom = 19 } = options;
      const padding = { top: paddingTopLeft[1], left: paddingTopLeft[0], bottom: paddingBottomRight[1], right: paddingBottomRight[0] };
      if (points.length === 1) move({ center: latLng(points[0]), zoom: Math.min(maxZoom, 15) });
      else {
        const bounds = new maplibregl.LngLatBounds();
        for (const point of points) bounds.extend(latLng(point));
        movingByCode = true;
        map.fitBounds(bounds, { padding, maxZoom, duration: 350 });
      }
    },
    setView(point, zoom) { move({ center: latLng(point), zoom }); },
    panTo(point) { move({ center: latLng(point) }); },
    removeLayer(marker) { marker.remove(); }
  };
}

export function vectorMarker(point, { icon, title }, map) {
  const element = document.createElement('div');
  element.title = title;
  const marker = new maplibregl.Marker({ element, anchor: 'center' })
    .setLngLat(latLng(point)).addTo(map.raw);
  const setIcon = next => {
    element.className = `maplibregl-marker ${next.options.className || ''}`;
    element.style.width = `${next.options.iconSize[0]}px`;
    element.style.height = `${next.options.iconSize[1]}px`;
    element.innerHTML = next.options.html;
    // The destination pin's tip, rather than its center, denotes the coordinate.
    marker.setOffset(element.classList.contains('destination-marker') ? [0, -20] : [0, 0]);
  };
  setIcon(icon);
  return {
    setLatLng(next) { marker.setLngLat(latLng(next)); return this; },
    getLatLng() { const p = marker.getLngLat(); return { lat: p.lat, lng: p.lng }; },
    setIcon,
    on(event, callback) { if (event === 'click') element.addEventListener('click', callback); return this; },
    remove() { marker.remove(); }
  };
}
