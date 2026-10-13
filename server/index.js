import { MqttConnection, normalizeSettings } from './mqtt.js';
import { Store } from './store.js';
import { Telemetry } from './telemetry.js';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
const config = loadConfig();
const { localPreview, port } = config;
const telemetry = new Telemetry();
const store = new Store(process.env.DATABASE_PATH || './data/eta.sqlite');
const expiredLinkCleanup = setInterval(() => store.pruneExpired(), 60_000);
expiredLinkCleanup.unref();
const connection = new MqttConnection(telemetry);
const persisted = store.loadConnection();
if (persisted) connection.apply(normalizeSettings(persisted));
else if (process.env.MQTT_URL) connection.apply(normalizeSettings({
  transport: /^(wss?|https?):/i.test(process.env.MQTT_URL) ? 'websocket' : 'mqtt',
  url: process.env.MQTT_URL, username: process.env.MQTT_USERNAME || '', password: process.env.MQTT_PASSWORD || '',
  cloudflare: !!(process.env.CF_ACCESS_CLIENT_ID || process.env.CF_ACCESS_CLIENT_SECRET),
  clientId: process.env.CF_ACCESS_CLIENT_ID || '', clientSecret: process.env.CF_ACCESS_CLIENT_SECRET || ''
}));
const server = createApp({ telemetry, store, config, connection }).listen(port, localPreview ? '127.0.0.1' : '0.0.0.0', () => console.log(`Tesla ETA listening on port ${port}${localPreview ? ' (loopback-only live preview)' : ''}`));
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => { clearInterval(expiredLinkCleanup); connection.close(); server.close(() => { store.db.close(); process.exit(0); }); server.closeAllConnections(); });
