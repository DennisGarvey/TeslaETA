const preview = document.querySelector('#product-preview');
const appearanceButtons = [...preview.querySelectorAll('[data-preview-theme]')];
const unitSelector = preview.querySelector('#preview-units');
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
const arrival = new Date(Date.now() + 18 * 60_000);
const arrivalFormatter = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

let appearance = 'light';
let setMapAppearance = () => {};

function updateAppearance() {
  const dark = appearance === 'dark' || (appearance === 'auto' && systemDark.matches);
  preview.dataset.previewDark = String(dark);
  setMapAppearance(dark ? 'dark' : 'light');
  for (const button of appearanceButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.previewTheme === appearance));
  }
}

for (const button of appearanceButtons) {
  button.addEventListener('click', () => {
    appearance = button.dataset.previewTheme;
    updateAppearance();
  });
}

systemDark.addEventListener('change', updateAppearance);
updateAppearance();

unitSelector.addEventListener('change', () => {
  const metric = unitSelector.value === 'metric';
  preview.querySelector('#preview-speed').textContent = metric ? '68' : '42';
  preview.querySelector('#preview-speed-unit').textContent = metric ? 'km/h' : 'mph';
  preview.querySelector('#preview-distance').textContent = metric ? '15.4' : '9.6';
  preview.querySelector('#preview-distance-unit').textContent = metric ? 'km remaining' : 'mi remaining';
});

function updateArrival() {
  preview.querySelector('#preview-arrival-time').textContent = arrivalFormatter.format(arrival);
  preview.querySelector('#preview-minutes').textContent = String(Math.max(0, Math.ceil((arrival.getTime() - Date.now()) / 60_000)));
}

updateArrival();
window.setInterval(updateArrival, 15_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) updateArrival(); });

const sampleVehicle = [-73.8406, 40.7213];
const sampleDestination = [-73.9743, 40.7681];
const mapBase = new URL('./', document.baseURI);
const asset = path => new URL(path, mapBase).href;

function prepareStyle(style) {
  return {
    ...style,
    transition: { duration: 300, delay: 0 },
    glyphs: asset('map-fonts/') + '{fontstack}/{range}.pbf',
    sprite: style.sprite.map(sprite => ({ ...sprite, url: asset('map-sprites/basics/sprites') }))
  };
}

function addMarker(map, coordinate, svg, title, anchor) {
  const element = document.createElement('div');
  element.innerHTML = svg;
  element.title = title;
  element.setAttribute('aria-label', title);
  new maplibregl.Marker({ element, anchor }).setLngLat(coordinate).addTo(map);
}

async function initializeMap() {
  if (!window.maplibregl) return;
  try {
    const styles = Object.fromEntries(await Promise.all(['light', 'dark'].map(async name => {
      const response = await fetch(asset(`map-styles/${name === 'light' ? 'colorful' : 'shadow'}.json`));
      if (!response.ok) throw new Error('Map style unavailable');
      return [name, prepareStyle(await response.json())];
    })));
    let currentStyle = preview.dataset.previewDark === 'true' ? 'dark' : 'light';
    const map = new maplibregl.Map({
      container: 'preview-map',
      style: structuredClone(styles[currentStyle]),
      center: [-73.91, 40.745],
      zoom: 11,
      maxZoom: 19,
      maxBounds: [[-74.28, 40.48], [-73.68, 40.94]],
      attributionControl: false,
      pitchWithRotate: false,
      dragRotate: false,
      touchPitch: false
    });
    map.on('error', event => {
      preview.querySelector('#preview-map').dataset.error = event.error?.message || 'Map error';
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
    setMapAppearance = name => {
      if (name === currentStyle) return;
      const from = styles[currentStyle], to = styles[name];
      for (let i = 0; i < to.layers.length; i++) {
        const layer = to.layers[i];
        if (!map.getLayer(layer.id)) continue;
        for (const [property, value] of Object.entries(layer.paint || {})) {
          if (JSON.stringify(value) !== JSON.stringify(from.layers[i].paint?.[property])) {
            map.setPaintProperty(layer.id, property, structuredClone(value));
          }
        }
      }
      currentStyle = name;
    };
    const recenter = document.querySelector('#preview-recenter');
    function fit() {
      recenter.hidden = true;
      map.fitBounds([sampleVehicle, sampleDestination], { padding: { top: 55, right: 52, bottom: 48, left: 40 }, maxZoom: 14, duration: 350 });
    }
    map.on('dragstart', () => { recenter.hidden = false; });
    map.on('zoomstart', event => { if (event.originalEvent) recenter.hidden = false; });
    for (const button of document.querySelectorAll('#preview-map .maplibregl-ctrl-zoom-in, #preview-map .maplibregl-ctrl-zoom-out')) {
      button.addEventListener('click', () => { recenter.hidden = false; });
    }
    recenter.addEventListener('click', fit);
    map.on('load', () => {
      addMarker(map, sampleVehicle, '<svg width="46" height="46" viewBox="0 0 46 46" style="transform:rotate(292deg)"><path d="M23 3L40 41L23 32L6 41Z" fill="#e82127" stroke="white" stroke-width="3" stroke-linejoin="round"/></svg>', 'Sample vehicle', 'center');
      addMarker(map, sampleDestination, '<svg width="34" height="44" viewBox="0 0 34 44"><path d="M17 42C14 36 3 26 3 17a14 14 0 1 1 28 0c0 9-11 19-14 25Z" fill="#22262b" stroke="white" stroke-width="2"/><circle cx="17" cy="17" r="5" fill="white"/></svg>', 'Central Park', 'bottom');
      fit();
      map.once('idle', () => preview.querySelector('.map-preview').classList.add('map-ready'));
      setMapAppearance(preview.dataset.previewDark === 'true' ? 'dark' : 'light');
    });
  } catch (error) {
    preview.querySelector('#preview-map').dataset.error = error.message;
    console.warn('Interactive map preview unavailable', error);
  }
}

if ('IntersectionObserver' in window) {
  const observer = new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting)) {
      observer.disconnect();
      initializeMap();
    }
  }, { rootMargin: '200px' });
  observer.observe(preview);
} else initializeMap();
