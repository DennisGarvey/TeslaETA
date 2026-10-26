import { MqttConnection, normalizeSettings } from './mqtt.js';
import { Store } from './store.js';
import { Telemetry } from './telemetry.js';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { logger, errorDetails } from './logger.js';

for (const event of ['uncaughtException', 'unhandledRejection']) process.on(event, error => {
  logger.error('Fatal server error', { event, ...errorDetails(error) });
  process.exit(1);
});

function start() {
  const config = loadConfig();
  const { localPreview, port } = config;
  const telemetry = new Telemetry();
  const store = new Store(process.env.DATABASE_PATH || './data/eta.sqlite');
  let cleanupFailed = false;
  const expiredLinkCleanup = setInterval(() => {
    try { store.pruneExpired(); cleanupFailed = false; }
    catch (error) {
      if (!cleanupFailed) logger.error('Expired link cleanup failed', errorDetails(error));
      cleanupFailed = true;
    }
  }, 60_000);
  expiredLinkCleanup.unref();
  const connection = new MqttConnection(telemetry);
  const persisted = store.loadConnection();
  const mqttSettings = persisted ? 'saved' : process.env.MQTT_URL ? 'environment' : 'not configured';
  if (persisted) connection.apply(normalizeSettings(persisted));
  else if (process.env.MQTT_URL) connection.apply(normalizeSettings({
    transport: /^(wss?|https?):/i.test(process.env.MQTT_URL) ? 'websocket' : 'mqtt',
    url: process.env.MQTT_URL, username: process.env.MQTT_USERNAME || '', password: process.env.MQTT_PASSWORD || '',
    cloudflare: !!(process.env.CF_ACCESS_CLIENT_ID || process.env.CF_ACCESS_CLIENT_SECRET),
    clientId: process.env.CF_ACCESS_CLIENT_ID || '', clientSecret: process.env.CF_ACCESS_CLIENT_SECRET || ''
  }));
  const server = createApp({ telemetry, store, config, connection }).listen(port, localPreview ? '127.0.0.1' : '0.0.0.0', () => {
    logger.info('Tesla ETA listening', { port: server.address().port, adminAuth: localPreview ? 'local preview' : config.adminAuthMode, mqttSettings });
  });
  server.on('error', error => {
    logger.error('HTTP server failed', errorDetails(error));
    process.exit(1);
  });
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    logger.info('Shutting down', { signal });
    clearInterval(expiredLinkCleanup);
    connection.close();
    server.close(() => { store.db.close(); process.exit(0); });
    server.closeAllConnections();
  });
}

try { start(); }
catch (error) {
  logger.error('Startup failed', errorDetails(error));
  process.exit(1);
}
