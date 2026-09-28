import mqtt from 'mqtt';
import WebSocket from 'ws';
import { enforceReadOnly } from './read-only.js';
export function cleanToken(value, header) {
  if (typeof value !== 'string') throw new Error('Token values must be text.');
  const cleaned = value.trim().replace(new RegExp(`^${header}\\s*:\\s*`, 'i'), '').trim();
  if (/[\r\n]/.test(cleaned) || cleaned.length > 4096) throw new Error('Paste one token value per field.');
  return cleaned;
}
export function normalizeSettings(input, previous = {}) {
  if (!input || typeof input.url !== 'string' || input.url.length > 2048) throw new Error('Enter an MQTT URL.');
  let rawUrl = input.url.trim();
  const protocol = rawUrl.match(/^([a-z]+):\/\//i)?.[1].toLowerCase();
  const transport = ['ws', 'wss', 'http', 'https'].includes(protocol) ? 'websocket' : ['mqtt', 'mqtts'].includes(protocol) ? 'mqtt' : input.transport;
  if (!['mqtt', 'websocket'].includes(transport)) throw new Error('Select an MQTT transport.');
  if (transport === 'websocket') rawUrl = rawUrl.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
  let url;
  try { url = new URL(rawUrl); } catch { throw new Error('Enter a complete MQTT URL including its protocol.'); }
  const allowed = transport === 'websocket' ? ['ws:', 'wss:'] : ['mqtt:', 'mqtts:'];
  if (!allowed.includes(url.protocol) || !url.hostname) throw new Error(transport === 'websocket' ? 'Use a ws:// or wss:// URL.' : 'Use an mqtt:// or mqtts:// URL.');
  if (url.username || url.password || url.hash || url.search) throw new Error('Use a URL without credentials, query parameters, or a fragment. Enter broker credentials separately.');
  if (transport === 'mqtt' && url.pathname && url.pathname !== '/') throw new Error('Regular MQTT URLs do not use a WebSocket path.');
  const cloudflare = input.cloudflare === true;
  if (cloudflare && url.protocol !== 'wss:') throw new Error('Cloudflare service tokens require a secure wss:// connection.');
  const username = typeof input.username === 'string' ? input.username.trim() : '';
  if (username.length > 256) throw new Error('Broker username is too long.');
  const password = input.clearPassword === true ? '' : (input.password || previous.password || '');
  if (typeof password !== 'string' || password.length > 4096) throw new Error('Broker password is too long.');
  const clientId = cloudflare ? cleanToken(input.clientId || previous.clientId || '', 'CF-Access-Client-Id') : '';
  const clientSecret = cloudflare ? cleanToken(input.clientSecret || previous.clientSecret || '', 'CF-Access-Client-Secret') : '';
  if (cloudflare && (!clientId || !clientSecret)) throw new Error('Enter both Cloudflare service-token values.');
  return { transport, url: url.toString(), username, password, cloudflare, clientId, clientSecret };
}
export class MqttConnection {
  constructor(telemetry) { this.telemetry = telemetry; this.settings = null; this.status = 'Not configured'; this.generation = 0; }
  publicSettings() {
    const s = this.settings || {};
    return { transport: s.transport || 'websocket', url: s.url || '', username: s.username || '', cloudflare: !!s.cloudflare,
      hasPassword: !!s.password, hasClientId: !!s.clientId, hasClientSecret: !!s.clientSecret, status: this.status };
  }
  apply(settings) {
    const generation = ++this.generation;
    this.client?.end(true);
    this.settings = settings;
    this.telemetry.connected = false; this.telemetry.cars.clear(); this.telemetry.emit('connection');
    this.status = 'Connecting';
    const current = () => generation === this.generation;
    const options = { username: settings.username || undefined, password: settings.password || undefined, reconnectPeriod: 5000, connectTimeout: 15000, clean: true };
    if (settings.transport === 'websocket') options.createWebsocket = url => new WebSocket(url, ['mqtt'], {
      headers: settings.cloudflare ? { 'CF-Access-Client-Id': settings.clientId, 'CF-Access-Client-Secret': settings.clientSecret } : {},
      handshakeTimeout: 15000, maxPayload: 65536
    });
    const client = enforceReadOnly(mqtt.connect(settings.url, options)); this.client = client;
    client.on('connect', () => {
      if (!current()) return;
      client.subscribe('teslamate/cars/+/+', { qos: 0 }, (error, granted) => {
        if (!current()) return;
        this.telemetry.connected = !error && !!granted?.length && granted.every(item => item.qos !== 128);
        this.status = this.telemetry.connected ? 'Connected' : 'Subscription rejected';
      });
    });
    client.on('message', (topic, payload, packet) => { if (current()) this.telemetry.ingest(topic, payload, packet.retain); });
    client.on('close', () => { if (current()) { this.telemetry.connected = false; this.status = 'Disconnected · retrying'; } });
    client.on('error', () => { if (current()) { this.telemetry.connected = false; this.status = 'Connection failed · check URL and credentials'; } });
  }
  close() { ++this.generation; this.client?.end(true); }
}
