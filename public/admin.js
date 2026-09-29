import { followFleetLocations, safeFitPadding } from '/assets/map-follow.js';
const $ = id => document.getElementById(id);
let displayedShareId = null;
const shareUrls = new Map();
const fleetMarkers = new Map();
const fleetMarkerStyles = new Map();
let fleetMap, fleetTracking, latestCars = [];
let carOptionsKey = '', fleetRowsKey = '';
const fleetArrow = heading => L.divIcon({ className: 'vehicle-marker fleet-arrow', iconSize: [46, 46], iconAnchor: [23, 23], html: `<svg width="46" height="46" viewBox="0 0 46 46" style="transform:rotate(${Number(heading) || 0}deg)"><path d="M23 3L40 41L23 32L6 41Z" fill="#e82127" stroke="white" stroke-width="3" stroke-linejoin="round"/></svg>` });
const fleetNumber = number => L.divIcon({ className: 'fleet-icon', iconSize: [30, 30], iconAnchor: [15, 15], html: `<span>${number}</span>` });
const shareIcon = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V3m0 0 4 4m-4-4L8 7M5 11v9h14v-9"/></svg>';
$('share').innerHTML = shareIcon;
function displayLink(id, url) {
  displayedShareId = id;
  $('created').hidden = false;
  $('url').value = url;
  $('open').href = url;
}
function showMqttConnection({ connected, configured }) {
  $('mqtt-alert').hidden = !!connected;
  $('mqtt-alert-text').textContent = configured ? 'MQTT is disconnected. Vehicle updates are unavailable.' : 'MQTT is not configured. Vehicle updates are unavailable.';
  setConnectionStatus(connected ? 'Connected' : configured ? 'Disconnected' : 'Not configured');
}
function setConnectionStatus(status) {
  const element = $('mqtt-status');
  element.textContent = status;
  element.className = `mqtt-status ${status === 'Connected' ? 'connected' : status === 'Connecting' ? 'connecting' : 'disconnected'}`;
}
function renderFleet(cars) {
  latestCars = [...cars].sort((a, b) => Number(a.id) - Number(b.id));
  $('fleet-count').textContent = `${cars.length} ${cars.length === 1 ? 'vehicle' : 'vehicles'}`;
  const nextOptionsKey = JSON.stringify(latestCars.map(car => [car.id, car.name]));
  if (nextOptionsKey !== carOptionsKey) {
    const previous = $('car').value;
    $('car').replaceChildren(...latestCars.map(car => new Option(car.name || `Tesla ${car.id}`, car.id)));
    if (latestCars.some(car => String(car.id) === previous)) $('car').value = previous;
    carOptionsKey = nextOptionsKey;
  }
  $('create').disabled = !latestCars.length;
  const nextRowsKey = JSON.stringify(latestCars.map(car => [car.id, car.name, car.state, !!car.location, car.locationFresh, car.locationLiveAt]));
  if (nextRowsKey !== fleetRowsKey) {
  const rows = latestCars.map((car, index) => {
    const row = document.createElement('button'); row.type = 'button'; row.className = 'fleet-vehicle'; row.dataset.carId = car.id;
    row.disabled = !car.location || !Number.isFinite(car.location.latitude) || !Number.isFinite(car.location.longitude);
    row.setAttribute('aria-pressed', String(fleetTracking?.selected() === car.id));
    row.onclick = () => fleetTracking?.select(car.id);
    const number = document.createElement('span'); number.className = 'fleet-number'; number.textContent = String(index + 1);
    const details = document.createElement('div');
    const name = document.createElement('strong'); name.textContent = car.name || `Tesla ${car.id}`;
    const state = document.createElement('span'); state.className = 'fleet-state'; state.textContent = car.state || 'State unavailable';
    const location = document.createElement('p'); location.className = 'muted';
    location.textContent = !car.location ? 'Location unavailable' : car.locationFresh && car.locationLiveAt ? `Location received ${new Date(car.locationLiveAt).toLocaleTimeString()}` : 'Last known location';
    details.append(name, state, location); row.append(number, details);
    return row;
  });
  if (rows.length) $('fleet-list').replaceChildren(...rows);
  else $('fleet-list').replaceChildren(Object.assign(document.createElement('p'), { className: 'muted fleet-empty', textContent: 'No vehicles received.' }));
  fleetRowsKey = nextRowsKey;
  }
  if (fleetMap) updateFleetMarkers();
}
function setFleetMarkerIcon(marker, car, index, selectedId) {
  const selected = car.id === selectedId;
  const key = selected ? `arrow:${Number(car.heading) || 0}` : `number:${index + 1}`;
  if (fleetMarkerStyles.get(car.id) !== key) {
    marker.setIcon(selected ? fleetArrow(car.heading) : fleetNumber(index + 1));
    fleetMarkerStyles.set(car.id, key);
  }
}
function showFleetSelection(id) {
  document.querySelectorAll('.fleet-vehicle').forEach(row => row.setAttribute('aria-pressed', String(row.dataset.carId === id)));
  latestCars.forEach((car, index) => { const marker = fleetMarkers.get(car.id); if (marker) setFleetMarkerIcon(marker, car, index, id); });
}
function updateFleetMarkers() {
  const present = new Set();
  latestCars.forEach((car, index) => {
    const point = car.location;
    if (!point || !Number.isFinite(point.latitude) || !Number.isFinite(point.longitude)) return;
    present.add(car.id);
    const position = [point.latitude, point.longitude];
    const icon = car.id === fleetTracking.selected() ? fleetArrow(car.heading) : fleetNumber(index + 1);
    let marker = fleetMarkers.get(car.id);
    if (!marker) {
      marker = L.marker(position, { icon, title: car.name || `Tesla ${car.id}` }).addTo(fleetMap);
      marker.on('click', () => fleetTracking.select(car.id));
      fleetMarkers.set(car.id, marker);
    } else {
      const previous = marker.getLatLng();
      if (previous.lat !== point.latitude || previous.lng !== point.longitude) marker.setLatLng(position);
      setFleetMarkerIcon(marker, car, index, fleetTracking.selected());
    }
    if (!fleetMarkerStyles.has(car.id)) fleetMarkerStyles.set(car.id, car.id === fleetTracking.selected() ? `arrow:${Number(car.heading) || 0}` : `number:${index + 1}`);
  });
  for (const [id, marker] of fleetMarkers) if (!present.has(id)) { fleetMap.removeLayer(marker); fleetMarkers.delete(id); fleetMarkerStyles.delete(id); }
  $('fleet-map-empty').hidden = present.size > 0;
  fleetTracking.update();
}
function initFleetMap() {
  if (fleetMap) { fleetMap.invalidateSize(); fleetTracking.update(true); return; }
  fleetMap = L.map('fleet-map', { zoomControl: false }).setView([39, -98], 4);
  L.control.zoom({ position: 'topright' }).addTo(fleetMap);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors', maxZoom: 19 }).addTo(fleetMap);
  fleetTracking = followFleetLocations(fleetMap,
    () => [...fleetMarkers.values()].map(marker => { const p = marker.getLatLng(); return [p.lat, p.lng]; }),
    id => { const p = fleetMarkers.get(id)?.getLatLng(); return p && [p.lat, p.lng]; },
    points => fleetMap.fitBounds(L.latLngBounds(points), { ...safeFitPadding(fleetMap.getSize()), maxZoom: points.length > 1 ? 19 : 15, animate: false }),
    (point, force) => {
      if (force || fleetMap.getZoom() !== 15) fleetMap.setView(point, 15, { animate: false });
      else fleetMap.panTo(point, { animate: false });
    }, $('fleet-fit'), showFleetSelection);
  updateFleetMarkers();
  requestAnimationFrame(() => { fleetMap.invalidateSize(); fleetTracking.update(true); });
}
async function shareLink(url, id) {
  if (!url) return;
  if (!navigator.share || (navigator.canShare && !navigator.canShare({ url }))) {
    if (id) displayLink(id, url);
    await copyLink(url);
    return;
  }
  try { await navigator.share({ title: 'Tesla ETA', url }); }
  catch (error) { if (error.name !== 'AbortError') { if (id) displayLink(id, url); $('message').textContent = 'Unable to open sharing. Use Copy link instead.'; } }
}
async function api(path, options = {}) {
  const response = await fetch(`/admin/api/${path}`, { ...options, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'TeslaETA' } });
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error || 'Request failed. Reload to sign in again.'); }
  return response.status === 204 ? null : response.json();
}
async function refresh() {
  try {
    const [status, shares] = await Promise.all([api('status'), api('shares')]);
    showMqttConnection(status);
    renderFleet(status.cars);
    if (displayedShareId && !shares.some(share => share.id === displayedShareId && share.expires_at > Date.now())) {
      displayedShareId = null; $('created').hidden = true; $('url').value = ''; $('open').removeAttribute('href'); $('message').textContent = '';
    }
    if (!$('connection-panel').hidden) { const settings = await api('connection'); setConnectionStatus(settings.status || 'Not configured'); }
    const activeShares = shares.filter(share => share.recoverable && share.expires_at > Date.now());
    const activeIds = new Set(activeShares.map(share => share.id));
    for (const id of shareUrls.keys()) if (!activeIds.has(id)) shareUrls.delete(id);
    await Promise.all(activeShares.map(async share => {
      if (shareUrls.has(share.id)) return;
      try { shareUrls.set(share.id, (await api(`shares/${share.id}/link`)).url); }
      catch { /* A link can expire or be revoked between list and recovery. */ }
    }));
    const vehicleNames = new Map(status.cars.map(car => [car.id, car.name]));
    $('shares').replaceChildren();
    if (!shares.length) $('shares').textContent = 'No sharing links yet.';
    for (const share of shares) {
      const row = document.createElement('div'); row.className = 'share-row';
      const detail = document.createElement('div'), url = shareUrls.get(share.id);
      const title = document.createElement(url ? 'a' : 'strong'), meta = document.createElement('p');
      title.className = 'share-title'; title.textContent = share.label || 'Vehicle link'; meta.className = 'muted';
      if (url) { title.href = url; title.target = '_blank'; title.rel = 'noopener noreferrer'; title.title = 'Open sharing link in a new tab'; }
      meta.textContent = `${Date.now() >= share.expires_at ? 'Expired' : 'Ends'} ${new Date(share.expires_at).toLocaleString()} · ${vehicleNames.get(share.car_id) || 'Vehicle name unavailable'}`;
      const count = document.createElement('p'); count.className = 'viewer-count'; count.dataset.shareId = share.id;
      count.title = 'Connected viewing tabs; multiple tabs count separately';
      setViewerCount(count, share.id);
      detail.append(title, meta, count);
      const revoke = document.createElement('button'); revoke.className = 'secondary'; revoke.textContent = 'Revoke';
      revoke.onclick = async () => { revoke.disabled = true; try { await api(`shares/${share.id}`, { method: 'DELETE' }); await refresh(); } catch (error) { $('message').textContent = error.message; revoke.disabled = false; } };
      const actions = document.createElement('div'); actions.className = 'share-actions';
      if (share.recoverable && Date.now() < share.expires_at) {
        const copy = document.createElement('button'); copy.className = 'secondary'; copy.textContent = 'Copy link';
        copy.onclick = async () => {
          copy.disabled = true;
          try {
            const result = await api(`shares/${share.id}/link`);
            shareUrls.set(share.id, result.url);
            displayLink(share.id, result.url);
            await copyLink(result.url);
          } catch (error) { $('message').textContent = error.message; }
          finally { copy.disabled = false; }
        };
        actions.append(copy);
        if (url) {
          const shareButton = document.createElement('button'); shareButton.className = 'secondary icon-button';
          shareButton.type = 'button'; shareButton.setAttribute('aria-label', 'Share link'); shareButton.title = 'Share link'; shareButton.innerHTML = shareIcon;
          shareButton.onclick = () => shareLink(url, share.id);
          actions.append(shareButton);
        }
      } else if (!share.recoverable && Date.now() < share.expires_at) {
        const hint = document.createElement('p'); hint.className = 'muted'; hint.textContent = 'Older link: create a new link if the original is lost.'; detail.append(hint);
      }
      actions.append(revoke);
      row.append(detail, actions); $('shares').append(row);
    }
  } catch (error) { $('message').textContent = error.message; }
}
$('share-form').onsubmit = async event => {
  event.preventDefault(); $('create').disabled = true;
  try { const share = await api('shares', { method: 'POST', body: JSON.stringify({ carId: $('car').value, label: $('label').value, hours: Number($('hours').value) }) }); shareUrls.set(share.id, share.url); displayLink(share.id, share.url); $('message').textContent = 'Sharing link created.'; $('label').value = ''; await refresh(); }
  catch (error) { $('message').textContent = error.message; }
  finally { $('create').disabled = !$('car').options.length; }
};
async function copyLink(url) { try { await navigator.clipboard.writeText(url); $('message').textContent = 'Link copied.'; } catch { $('url').focus(); $('url').select(); $('message').textContent = 'Select and copy the link above.'; } }
$('copy').onclick = () => copyLink($('url').value);
$('share').onclick = () => shareLink($('url').value, displayedShareId);
let viewerCounts = {}, countsConnected = false;
function setViewerCount(element, id) {
  const count = viewerCounts[id] || 0;
  element.textContent = countsConnected ? `${count} ${count === 1 ? 'viewer' : 'viewers'}` : 'Viewers: reconnecting…';
}
const viewerEvents = new EventSource('/admin/api/viewers/events');
viewerEvents.addEventListener('viewers', event => {
  viewerCounts = JSON.parse(event.data); countsConnected = true;
  document.querySelectorAll('.viewer-count').forEach(element => setViewerCount(element, element.dataset.shareId));
});
viewerEvents.addEventListener('connection', event => showMqttConnection(JSON.parse(event.data)));
viewerEvents.addEventListener('vehicles', event => renderFleet(JSON.parse(event.data)));
viewerEvents.onerror = () => {
  countsConnected = false;
  document.querySelectorAll('.viewer-count').forEach(element => setViewerCount(element, element.dataset.shareId));
};
window.addEventListener('pagehide', () => viewerEvents.close());
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
refresh(); setInterval(refresh, 15000);

function connectionFields() {
  const websocket = $('transport').value === 'websocket';
  $('cloudflare-option').hidden = !websocket;
  if (!websocket) $('cloudflare-enabled').checked = false;
  $('cloudflare-fields').hidden = !$('cloudflare-enabled').checked;
  $('mqtt-url').placeholder = websocket ? 'wss://mqtt.example.com/mqtt' : 'mqtt://broker:1883';
}
function showConnection(settings) {
  $('transport').value = settings.transport || 'websocket'; $('mqtt-url').value = settings.url || '';
  $('mqtt-user').value = settings.username || ''; $('cloudflare-enabled').checked = !!settings.cloudflare;
  for (const id of ['mqtt-password', 'cf-client-id', 'cf-client-secret']) $(id).value = '';
  $('mqtt-password').placeholder = '';
  $('cf-client-id').placeholder = '';
  $('cf-client-secret').placeholder = '';
  $('mqtt-password-hint').hidden = !settings.hasPassword;
  $('cf-client-id-hint').hidden = !settings.hasClientId;
  $('cf-client-secret-hint').hidden = !settings.hasClientSecret;
  $('clear-password').checked = false;
  setConnectionStatus(settings.status || 'Not configured');
  $('connection-message').textContent = '';
  connectionFields();
}
async function selectPanel(connection) {
  const active = connection === true ? 'connection' : connection === 'settings' ? 'settings' : 'sharing';
  for (const name of ['sharing', 'connection', 'settings']) {
    $(name + '-panel').hidden = name !== active;
    $(name + '-tab').setAttribute('aria-pressed', String(name === active));
  }
  if (active === 'connection') { initFleetMap(); try { showConnection(await api('connection')); } catch (error) { $('connection-message').textContent = error.message; } }
  if (active === 'settings') { try { const settings = await api('sharing-settings'); $('public-origin').value = settings.publicOrigin; } catch (error) { $('sharing-settings-message').textContent = error.message; } }
}
$('settings-tab').onclick = () => selectPanel('settings');
$('sharing-settings-form').onsubmit = async event => {
  event.preventDefault(); $('save-sharing-settings').disabled = true;
  try {
    const settings = await api('sharing-settings', { method: 'PUT', body: JSON.stringify({ publicOrigin: $('public-origin').value }) });
    $('public-origin').value = settings.publicOrigin;
    $('sharing-settings-message').textContent = 'Sharing URL saved.';
    shareUrls.clear();
    displayedShareId = null; $('created').hidden = true; $('url').value = ''; $('open').removeAttribute('href'); $('message').textContent = '';
    await refresh();
  } catch (error) { $('sharing-settings-message').textContent = error.message; }
  finally { $('save-sharing-settings').disabled = false; }
};
$('sharing-tab').onclick = () => selectPanel(false);
$('connection-tab').onclick = () => selectPanel(true);
$('mqtt-alert-settings').onclick = () => selectPanel(true);
function detectTransport() {
  const protocol = $('mqtt-url').value.trim().match(/^([a-z]+):\/\//i)?.[1].toLowerCase();
  if (['ws', 'wss', 'http', 'https'].includes(protocol)) $('transport').value = 'websocket';
  else if (['mqtt', 'mqtts'].includes(protocol)) $('transport').value = 'mqtt';
  connectionFields();
}
$('mqtt-url').addEventListener('input', detectTransport);
$('transport').onchange = detectTransport;
$('cloudflare-enabled').onchange = connectionFields;
$('connection-form').onsubmit = async event => {
  event.preventDefault(); detectTransport(); $('save-connection').disabled = true;
  try {
    const settings = await api('connection', { method: 'PUT', body: JSON.stringify({
      transport: $('transport').value, url: $('mqtt-url').value, username: $('mqtt-user').value,
      password: $('mqtt-password').value, clearPassword: $('clear-password').checked,
      cloudflare: $('cloudflare-enabled').checked, clientId: $('cf-client-id').value, clientSecret: $('cf-client-secret').value
    }) });
    showConnection(settings); setConnectionStatus('Connecting'); await refresh();
  } catch (error) { $('connection-message').textContent = error.message; }
  finally { $('save-connection').disabled = false; }
};
