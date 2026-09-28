const $ = id => document.getElementById(id);
let displayedShareId = null;
async function api(path, options = {}) {
  const response = await fetch(`/admin/api/${path}`, { ...options, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'TeslaETA' } });
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error || 'Request failed. Reload to sign in again.'); }
  return response.status === 204 ? null : response.json();
}
async function refresh() {
  try {
    const [status, shares] = await Promise.all([api('status'), api('shares')]);
    if (displayedShareId && !shares.some(share => share.id === displayedShareId && share.expires_at > Date.now())) {
      displayedShareId = null; $('created').hidden = true; $('url').value = ''; $('open').removeAttribute('href'); $('message').textContent = '';
    }
    if (!$('connection-panel').hidden) { const settings = await api('connection'); $('connection-message').textContent = settings.status || ''; }
    const vehicleNames = new Map(status.cars.map(car => [car.id, car.name]));
    const previous = $('car').value;
    $('car').replaceChildren(...status.cars.map(car => new Option(car.name || `Tesla ${car.id}`, car.id)));
    if (status.cars.some(car => car.id === previous)) $('car').value = previous;
    $('create').disabled = !status.cars.length;
    $('shares').replaceChildren();
    if (!shares.length) $('shares').textContent = 'No sharing links yet.';
    for (const share of shares) {
      const row = document.createElement('div'); row.className = 'share-row';
      const detail = document.createElement('div'), title = document.createElement('strong'), meta = document.createElement('p');
      title.textContent = share.label || 'Vehicle link'; meta.className = 'muted';
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
            displayedShareId = share.id;
            $('created').hidden = false; $('url').value = result.url; $('open').href = result.url;
            await copyLink(result.url);
          } catch (error) { $('message').textContent = error.message; }
          finally { copy.disabled = false; }
        };
        actions.append(copy);
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
  try { const share = await api('shares', { method: 'POST', body: JSON.stringify({ carId: $('car').value, label: $('label').value, hours: Number($('hours').value) }) }); displayedShareId = share.id; $('created').hidden = false; $('url').value = share.url; $('open').href = share.url; $('message').textContent = 'Sharing link created.'; $('label').value = ''; await refresh(); }
  catch (error) { $('message').textContent = error.message; }
  finally { $('create').disabled = !$('car').options.length; }
};
async function copyLink(url) { try { await navigator.clipboard.writeText(url); $('message').textContent = 'Link copied.'; } catch { $('url').focus(); $('url').select(); $('message').textContent = 'Select and copy the link above.'; } }
$('copy').onclick = () => copyLink($('url').value);
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
    displayedShareId = null; $('created').hidden = true; $('url').value = ''; $('open').removeAttribute('href'); $('message').textContent = '';
  } catch (error) { $('sharing-settings-message').textContent = error.message; }
  finally { $('save-sharing-settings').disabled = false; }
};
$('sharing-tab').onclick = () => selectPanel(false);
$('connection-tab').onclick = () => selectPanel(true);
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
