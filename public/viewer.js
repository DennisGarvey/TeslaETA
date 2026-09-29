import { followLocations, safeFitPadding } from '/assets/map-follow.js';
const $ = id => document.getElementById(id);
const map = L.map('map', { zoomControl: false }).setView([39, -98], 4);
L.control.zoom({ position: 'topright' }).addTo(map);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors', maxZoom: 19 }).addTo(map);
let carMarker, destinationMarker, latest;
const arrow = heading => L.divIcon({ className: 'vehicle-marker', iconSize: [46, 46], iconAnchor: [23, 23], html: `<svg width="46" height="46" viewBox="0 0 46 46" style="transform:rotate(${Number(heading) || 0}deg)"><path d="M23 3L40 41L23 32L6 41Z" fill="#e82127" stroke="white" stroke-width="3" stroke-linejoin="round"/></svg>` });
const destinationIcon = L.divIcon({ className: 'destination-marker', iconSize: [34, 44], iconAnchor: [17, 42], html: '<svg width="34" height="44" viewBox="0 0 34 44" aria-hidden="true"><path d="M17 42C14 36 3 26 3 17a14 14 0 1 1 28 0c0 9-11 19-14 25Z" fill="#22262b" stroke="white" stroke-width="2"/><circle cx="17" cy="17" r="5" fill="white"/></svg>' });
const tracking = followLocations(map,
  () => [carMarker, destinationMarker].filter(Boolean).map(marker => { const p = marker.getLatLng(); return [p.lat, p.lng]; }),
  points => map.fitBounds(L.latLngBounds(points), { ...safeFitPadding(map.getSize()), maxZoom: points.length > 1 ? 19 : 15, animate: false }), $('fit'));
$('units').onchange = () => latest && render(latest);
const number = n => n == null ? '—' : Math.round(n).toString();
function renderTime() {
  const arrivalAt = latest?.arrivalAt;
  $('minutes').textContent = arrivalAt == null ? '—' : String(Math.max(0, Math.ceil((arrivalAt - Date.now()) / 60000)));
  $('arrival').textContent = arrivalAt == null ? '—' : new Date(arrivalAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function render(data) {
  const imperial = $('units').value === 'imperial';
  $('vehicle').textContent = data.name || 'Tesla';
  $('destination').textContent = data.route?.destination || 'No active destination';
  const notice = data.waiting ? 'Waiting for vehicle data.' : !data.connected ? 'Vehicle connection interrupted. Values may be out of date.' : !data.route ? 'Navigation inactive. No arrival estimate available.' : !data.locationFresh || !data.routeFresh ? 'Some data is stale or retained. Waiting for fresh vehicle updates.' : '';
  $('notice').textContent = notice;
  $('notice').hidden = !notice;
  renderTime();
  $('speed').textContent = data.speedFresh ? number(data.speed == null ? null : data.speed * (imperial ? 0.621371 : 1)) : '—';
  $('speed-unit').textContent = imperial ? 'mph' : 'km/h';
  $('distance').textContent = data.routeFresh && data.route?.miles != null ? (data.route.miles * (imperial ? 1 : 1.609344)).toFixed(1) : '—';
  $('distance-unit').textContent = imperial ? 'mi remaining' : 'km remaining';
  $('battery').textContent = data.routeFresh && data.route?.battery != null ? `${number(data.route.battery)}%` : '—';
  $('traffic').textContent = data.routeFresh && data.route?.traffic != null ? `${number(data.route.traffic)} min` : '—';
  $('freshness').textContent = data.locationLiveAt ? `Location received ${new Date(data.locationLiveAt).toLocaleTimeString()}` : data.location ? 'Retained location · original update time unknown' : 'Waiting for location';
  $('expiry').textContent = `Sharing ends ${new Date(data.expiresAt).toLocaleString()}`;
  if (data.location) { const point = [data.location.latitude, data.location.longitude]; if (!carMarker) carMarker = L.marker(point, { icon: arrow(data.heading), title: 'Vehicle' }).addTo(map); else carMarker.setLatLng(point).setIcon(arrow(data.heading)); }
  else if (carMarker) { map.removeLayer(carMarker); carMarker = null; }
  if (data.route?.location) { const point = [data.route.location.latitude, data.route.location.longitude]; if (!destinationMarker) destinationMarker = L.marker(point, { icon: destinationIcon, title: 'Navigation destination' }).addTo(map); else destinationMarker.setLatLng(point); }
  else if (destinationMarker) { map.removeLayer(destinationMarker); destinationMarker = null; }
  tracking.update();
}
const stream = new EventSource(`${location.pathname.replace(/\/$/, '')}/events`);
const clock = setInterval(renderTime, 10000);
stream.addEventListener('snapshot', event => {
  try { latest = JSON.parse(event.data); render(latest); }
  catch { $('notice').textContent = 'Unable to display the latest update.'; }
});
stream.addEventListener('ended', () => {
  stream.close();
  clearInterval(clock);
  document.querySelector('.journey').replaceChildren(Object.assign(document.createElement('p'), { className: 'unavailable', textContent: 'This sharing link has expired or was revoked.' }));
});
stream.onerror = () => {
  if (latest) { latest.connected = false; latest.locationFresh = false; latest.routeFresh = false; latest.speedFresh = false; latest.arrivalAt = null; render(latest); }
  $('notice').textContent = 'Connection lost. Showing the last known location while reconnecting.';
  $('notice').hidden = false;
};
window.addEventListener('pagehide', () => { stream.close(); clearInterval(clock); });
// A page restored from the back-forward cache needs a fresh EventSource.
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
