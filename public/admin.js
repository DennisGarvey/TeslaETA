const $ = id => document.getElementById(id);
let displayedShareId = null;
const shareUrls = new Map();
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
    if (displayedShareId && !shares.some(share => share.id === displayedShareId && share.expires_at > Date.now())) {
      displayedShareId = null; $('created').hidden = true; $('url').value = ''; $('open').removeAttribute('href'); $('message').textContent = '';
    }
    if (!$('connection-panel').hidden) { const settings = await api('connection'); $('connection-message').textContent = settings.status || ''; }
    const activeShares = shares.filter(share => share.recoverable && share.expires_at > Date.now());
    const activeIds = new Set(activeShares.map(share => share.id));
    for (const id of shareUrls.keys()) if (!activeIds.has(id)) shareUrls.delete(id);
    await Promise.all(activeShares.map(async share => {
      if (shareUrls.has(share.id)) return;
      try { shareUrls.set(share.id, (await api(`shares/${share.id}/link`)).url); }
      catch { /* A link can expire or be revoked between list and recovery. */ }
    }));
    const vehicleNames = new Map(status.cars.map(car => [car.id, car.name]));
    const previous = $('car').value;
    $('car').replaceChildren(...status.cars.map(car => new Option(car.name || `Tesla ${car.id}`, car.id)));
    if (status.cars.some(car => car.id === previous)) $('car').value = previous;
    $('create').disabled = !status.cars.length;
    $('shares').replaceChildren();
    if (!shares.length) $('shares').textContent = 'No sharing links yet.';
    for (const share of shares) {
      const row = document.createElement('div'); row.className = 'share-row';
      const detail = document.createElement('div'), url = shareUrls.get(share.id);
      const title = document.createElement(url ? 'a' : 'strong'), meta = document.createElement('p');
      title.className = 'share-title'; title.textContent = share.label || 'Vehicle link'; meta.className = 'muted';
      if (url) { title.href = url; title.target = '_blank'; title.rel = 'noopener noreferrer'; title.title = 'Open sharing link in a new tab'; }
      const expired = Date.now() >= share.expires_at;
      meta.textContent = `${expired ? 'Expired' : 'Ends'} ${new Date(share.expires_at).toLocaleString()} · ${vehicleNames.get(share.car_id) || 'Vehicle name unavailable'}`;
      const count = document.createElement('p'); count.className = 'viewer-count'; count.dataset.shareId = share.id;
      count.title = 'Connected viewing tabs; multiple tabs count separately';
      setViewerCount(count, share.id);
      detail.append(title, meta, count);
      const revoke = document.createElement('button'); revoke.className = 'secondary'; revoke.textContent = expired ? 'Remove' : 'Revoke';
      revoke.onclick = async () => { revoke.disabled = true; try { await api(`shares/${share.id}`, { method: 'DELETE' }); await refresh(); } catch (error) { $('message').textContent = error.message; revoke.disabled = false; } };
      const actions = document.createElement('div'); actions.className = 'share-actions';
      if (share.recoverable && !expired) {
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
      } else if (!share.recoverable && !expired) {
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
  $('mqtt-password').placeholder = settings.hasPassword ? 'Saved · leave blank to keep' : 'Optional broker password';
  $('cf-client-id').placeholder = settings.hasClientId ? 'Saved · leave blank to keep' : 'Client ID or CF-Access-Client-Id: value';
  $('cf-client-secret').placeholder = settings.hasClientSecret ? 'Saved · leave blank to keep' : 'Secret or CF-Access-Client-Secret: value';
  $('clear-password').checked = false;
  $('connection-message').textContent = settings.status || '';
  connectionFields();
}
async function selectPanel(connection) {
  const active = connection === true ? 'connection' : connection === 'settings' ? 'settings' : 'sharing';
  for (const name of ['sharing', 'connection', 'settings']) {
    $(name + '-panel').hidden = name !== active;
    $(name + '-tab').setAttribute('aria-pressed', String(name === active));
  }
  if (active === 'connection') { try { showConnection(await api('connection')); } catch (error) { $('connection-message').textContent = error.message; } }
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
    showConnection(settings); $('connection-message').textContent = 'Settings saved. Connecting…'; await refresh();
  } catch (error) { $('connection-message').textContent = error.message; }
  finally { $('save-connection').disabled = false; }
};
