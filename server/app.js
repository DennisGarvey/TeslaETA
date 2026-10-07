import express from 'express';
import { normalizeSharingOrigin } from './sharing-settings.js';
import { Viewers, streamViewers } from './viewers.js';
import { normalizeSettings } from './mqtt.js';
import { streamShare } from './stream.js';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { fileURLToPath } from 'node:url';
const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
export function createApp({ telemetry, store, config, verifyAdmin, connection }) {
  const app = express();
  const viewers = new Viewers();
  const sharingOrigin = () => store.sharingOrigin() || config.publicOrigin;
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'strict-origin', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://tile.openstreetmap.org https://vector.openstreetmap.org; connect-src 'self' https://vector.openstreetmap.org; font-src 'self' data: https://vector.openstreetmap.org; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'", 'Permissions-Policy': 'geolocation=(), camera=(), microphone=()' });
    next();
  });
  app.use(express.json({ limit: '24kb' }));
  const jwks = config.accessIssuer ? createRemoteJWKSet(new URL('/cdn-cgi/access/certs', config.accessIssuer)) : null;
  app.use('/admin', async (req, res, next) => {
    if (config.localPreview) return next();
    try {
      if (verifyAdmin) await verifyAdmin(req);
      else {
        if (!jwks || !config.accessAudience) throw new Error('Access is not configured');
        const { payload } = await jwtVerify(req.get('Cf-Access-Jwt-Assertion') || '', jwks, { issuer: config.accessIssuer, audience: config.accessAudience, algorithms: ['RS256'] });
        req.accessExpiresAt = payload.exp * 1000;
      }
      if (!['GET', 'HEAD'].includes(req.method) && (req.get('origin') !== config.publicOrigin || req.get('x-requested-with') !== 'TeslaETA')) return res.status(403).json({ error: 'Invalid request origin' });
      next();
    } catch { res.status(403).json({ error: 'Sign in through Cloudflare Access to open administration.' }); }
  });
  app.get('/admin/api/sharing-settings', (req, res) => res.json({ publicOrigin: sharingOrigin() }));
  app.put('/admin/api/sharing-settings', (req, res) => {
    let origin;
    try { origin = normalizeSharingOrigin(req.body?.publicOrigin, config.localPreview); }
    catch (error) { return res.status(400).json({ error: error.message }); }
    store.saveSharingOrigin(origin);
    res.json({ publicOrigin: origin });
  });
  app.get('/admin/api/connection', (req, res) => res.json(connection?.publicSettings() || {}));
  app.put('/admin/api/connection', (req, res) => {
    if (!connection) return res.status(503).json({ error: 'Connection settings are unavailable.' });
    let settings;
    try { settings = normalizeSettings(req.body, connection.settings || {}); }
    catch (error) { return res.status(400).json({ error: error.message }); }
    store.saveConnection(settings);
    connection.apply(settings);
    res.json(connection.publicSettings());
  });
  app.get('/admin/api/status', (req, res) => res.json({ localPreview: config.localPreview, connected: telemetry.connected, configured: connection ? !!connection.settings : config.mqttConfigured, nextLinkName: store.nextLinkName(), cars: [...telemetry.cars.keys()].map(id => telemetry.snapshot(id)) }));
  app.get('/admin/api/viewers/events', (req, res) => streamViewers(req, res, viewers, telemetry, () => connection ? !!connection.settings : config.mqttConfigured));
  app.get('/admin/api/shares', (req, res) => res.json(store.list().map(share => ({ ...share, viewers: viewers.count(share.id) }))));
  app.get('/admin/api/shares/:id/link', (req, res) => {
    const token = store.recover(req.params.id);
    if (!token) return res.status(404).json({ error: 'This link is expired, revoked, or was created before link recovery was available.' });
    res.json({ url: `${sharingOrigin()}/s/${token}` });
  });
  app.post('/admin/api/shares', (req, res) => {
    const { carId, label = '', hours } = req.body || {};
    if (typeof carId !== 'string' || !telemetry.cars.has(carId) || typeof label !== 'string' || label.length > 100 || !Number.isFinite(hours) || hours < 1 || hours > 168) return res.status(400).json({ error: 'Choose a vehicle and an expiry between 1 and 168 hours. Link names must be 100 characters or fewer.' });
    const share = store.create(carId, label.trim(), hours);
    res.status(201).json({ ...share, url: `${sharingOrigin()}/s/${share.token}` });
  });
  app.delete('/admin/api/shares/:id', (req, res) => { store.revoke(req.params.id); res.sendStatus(204); });
  app.get('/s/:token/events', (req, res) => streamShare(req, res, { telemetry, store, config, viewers }));
  app.get('/s/:token/data', (req, res) => {
    if (!/^[A-Za-z0-9_-]{43}$/.test(req.params.token)) return res.status(404).json({ error: 'This link is unavailable or has expired.' });
    const share = store.resolve(req.params.token);
    if (!share) return res.status(404).json({ error: 'This link is unavailable or has expired.' });
    res.json({ ...telemetry.snapshot(share.car_id), expiresAt: share.expires_at, localPreview: config.localPreview });
  });
  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.get('/admin/app.js', (req, res) => res.sendFile(`${publicDir}admin.js`));
  app.get(['/admin', '/admin/'], (req, res) => res.sendFile(`${publicDir}admin.html`));
  app.get('/assets/style.css', (req, res) => res.sendFile(`${publicDir}style.css`));
  app.get('/assets/theme.js', (req, res) => res.sendFile(`${publicDir}theme.js`));
  app.get('/assets/map-follow.js', (req, res) => res.sendFile(`${publicDir}map-follow.js`));
  app.get('/assets/vector-map.js', (req, res) => res.sendFile(`${publicDir}vector-map.js`));
  app.get('/assets/viewer.js', (req, res) => res.sendFile(`${publicDir}viewer.js`));
  app.get('/favicon.svg', (req, res) => res.sendFile(`${publicDir}favicon.svg`));
  app.get('/apple-touch-icon.png', (req, res) => res.sendFile(`${publicDir}apple-touch-icon.png`));
  app.use('/assets/leaflet', express.static(fileURLToPath(new URL('../node_modules/leaflet/dist/', import.meta.url))));
  app.use('/assets/maplibre', express.static(fileURLToPath(new URL('../node_modules/maplibre-gl/dist/', import.meta.url))));
  app.get('/s/:token', (req, res) => res.sendFile(`${publicDir}viewer.html`));
  app.get('/', (req, res) => res.sendFile(`${publicDir}index.html`));
  app.use((req, res) => res.status(404).json({ error: 'Not found' }));
  app.use((err, req, res, next) => res.status(err.status === 400 ? 400 : 500).json({ error: 'Unable to complete the request.' }));
  return app;
}
