const maplibregl = window.maplibregl;

const lightStyle = '/assets/map-styles/colorful.json';
const darkPalette = new URLSearchParams(location.search).get('dark') === 'eclipse' ? 'eclipse' : 'shadow';
const darkStyle = `/assets/map-styles/${darkPalette}.json`;
const latLng = point => [point[1], point[0]];
const absoluteStyleAssets = (_, style) => ({
  ...style,
  transition: { duration: 0, delay: 0 },
  glyphs: `${location.origin}${style.glyphs}`,
  sprite: style.sprite.map(sprite => ({ ...sprite, url: `${location.origin}${sprite.url}` }))
});

export function vectorMapEnabled() {
  return new URLSearchParams(location.search).get('map') !== 'raster';
}

export function enableTrackpadGestures(map) {
  const container = map.getContainer();
  let gesture = null, touches = 0;
  const touch = event => { touches = event.touches.length; };
  const start = event => {
    // Touchscreens already use MapLibre's native pinch, rotate and pitch handlers.
    if (touches) return;
    event.preventDefault();
    map.stop();
    const rect = container.getBoundingClientRect();
    gesture = { bearing: map.getBearing(), zoom: map.getZoom(),
      around: map.unproject([event.clientX - rect.left, event.clientY - rect.top]) };
  };
  const change = event => {
    if (!gesture || touches) return;
    event.preventDefault();
    if (!Number.isFinite(event.rotation) || !Number.isFinite(event.scale) || event.scale <= 0) return;
    map.easeTo({ bearing: gesture.bearing - event.rotation,
      zoom: gesture.zoom + Math.log2(event.scale), around: gesture.around, duration: 0 }, { originalEvent: event });
  };
  const end = event => { if (gesture) event.preventDefault(); gesture = null; };
  const wheel = event => {
    if (gesture && event.ctrlKey) { event.preventDefault(); event.stopImmediatePropagation(); }
  };
  const listeners = { touchstart: touch, touchend: touch, touchcancel: touch,
    gesturestart: start, gesturechange: change, gestureend: end, wheel };
  for (const [name, listener] of Object.entries(listeners)) container.addEventListener(name, listener, { passive: false, capture: true });
  map.on('remove', () => {
    for (const [name, listener] of Object.entries(listeners)) container.removeEventListener(name, listener, true);
  });
}

export function createVectorMap(container) {
  const dark = () => document.documentElement.classList.contains('theme-dark');
  const styleUrls = { light: lightStyle, dark: darkStyle };
  const styleCache = new Map();
  for (const [name, url] of Object.entries(styleUrls)) {
    fetch(url).then(response => {
      if (!response.ok) throw new Error('Map style unavailable');
      return response.json();
    }).then(style => styleCache.set(name, absoluteStyleAssets(null, style))).catch(() => {});
  }
  const map = new maplibregl.Map({
    container, style: { version: 8, sources: {}, layers: [] },
    center: [-98, 39], zoom: 4, maxZoom: 19,
    attributionControl: false, fadeDuration: 0
  });
  enableTrackpadGestures(map);
  let currentStyleName = dark() ? 'dark' : 'light';
  const setStyle = name => {
    const current = styleCache.get(currentStyleName);
    const next = styleCache.get(name);
    if (current && next && next.layers.every((layer, index) => layer.id === current.layers[index]?.id && map.getLayer(layer.id))) {
      next.layers.forEach((layer, index) => {
        for (const [property, value] of Object.entries(layer.paint || {})) {
          if (JSON.stringify(value) !== JSON.stringify(current.layers[index].paint?.[property])) {
            map.setPaintProperty(layer.id, property, structuredClone(value));
          }
        }
      });
    } else if (next) map.setStyle(structuredClone(next));
    else map.setStyle(styleUrls[name], { transformStyle: absoluteStyleAssets });
    currentStyleName = name;
  };
  setStyle(currentStyleName);
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
  let priorDark = dark();
  const observer = new MutationObserver(() => {
    const nextDark = dark();
    if (nextDark !== priorDark) { priorDark = nextDark; setStyle(nextDark ? 'dark' : 'light'); }
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

  const move = options => map.easeTo({ ...options, duration: 350 });
  return {
    raw: map,
    on(events, callback) {
      for (const event of events.split(' ')) map.on(event, (...args) => {
        // Resize and camera animations also emit movement events. Only actual
        // pointer, touch, keyboard or control input should pause tracking.
        if (!['dragstart', 'movestart', 'zoomstart', 'pitchstart'].includes(event) || args[0]?.originalEvent) callback(...args);
      });
      return this;
    },
    getSize() { return { x: map.getContainer().clientWidth, y: map.getContainer().clientHeight }; },
    getZoom() { return map.getZoom(); },
    resetPitch() { if (map.getPitch() !== 0) map.setPitch(0); },
    invalidateSize() { map.resize(); },
    fitBounds(points, options = {}) {
      const { paddingTopLeft = [0, 0], paddingBottomRight = [0, 0], maxZoom = 19 } = options;
      const padding = { top: paddingTopLeft[1], left: paddingTopLeft[0], bottom: paddingBottomRight[1], right: paddingBottomRight[0] };
      if (points.length === 1) move({ center: latLng(points[0]), zoom: Math.min(maxZoom, 15) });
      else {
        const bounds = new maplibregl.LngLatBounds();
        for (const point of points) bounds.extend(latLng(point));
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
    const alignment = element.classList.contains('vehicle-marker') ? 'map' : 'viewport';
    marker.setRotationAlignment(alignment);
    marker.setPitchAlignment(alignment);
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
