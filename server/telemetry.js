import { EventEmitter } from 'node:events';
import { decodeRouteLine, distanceMeters, routeLineMaxBytes } from '../public/route-line.js';
const numeric = value => value !== null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
const bounded = (value, min, max) => { const n = numeric(value); return n !== null && n >= min && n <= max ? n : null; };
const lineMatchesDestination = (line, activeRoute) => line && (!activeRoute || (activeRoute.value && distanceMeters(line.end, [activeRoute.value.location.latitude, activeRoute.value.location.longitude]) <= 500));
export function location(value) {
  if (!value || typeof value !== 'object') return null;
  const latitude = bounded(value.latitude, -90, 90), longitude = bounded(value.longitude, -180, 180);
  return latitude === null || longitude === null ? null : { latitude, longitude };
}
export class Telemetry extends EventEmitter {
  constructor() { super(); this.setMaxListeners(0); this.cars = new Map(); this._connected = false; }
  get connected() { return this._connected; }
  set connected(value) { if (this._connected !== value) { this._connected = value; this.emit('connection'); } }
  ingest(topic, payload, retained = false, now = Date.now()) {
    const match = /^teslamate\/cars\/(\d+)\/([a-zA-Z_]+)$/.exec(topic);
    if (!match) return;
    const [, id, topicField] = match;
    const field = topicField === 'RouteLine' ? 'route_line' : topicField;
    if (!['display_name','state','healthy','speed','heading','battery_level','location','active_route','route_line'].includes(field) || payload.length > (field === 'route_line' ? routeLineMaxBytes + 2 : 16384)) return;
    let value = payload.toString();
    if (['location','active_route'].includes(field)) { try { value = JSON.parse(value); } catch { return; } }
    const car = this.cars.get(id) || { id, fields: {} };
    if (field === 'route_line') {
      value = value.trim();
      if (value.startsWith('"')) { try { value = JSON.parse(value); } catch { value = null; } }
      const points = decodeRouteLine(value);
      value = points ? { encoded: value, end: points.at(-1) } : null;
    }
    if (field === 'location') value = location(value);
    if (field === 'speed') value = bounded(value, 0, 500);
    if (field === 'heading') value = bounded(value, 0, 360);
    if (field === 'battery_level') value = bounded(value, 0, 100);
    if (field === 'healthy') value = value === 'true';
    if (field === 'display_name' || field === 'state') value = value.slice(0, 100);
    if (field === 'active_route') value = value && !value.error && location(value.location) ? {
      destination: String(value.destination || 'Destination').slice(0, 200), location: location(value.location),
      minutes: bounded(value.minutes_to_arrival, 0, 100000), miles: bounded(value.miles_to_arrival, 0, 100000),
      battery: bounded(value.energy_at_arrival, 0, 100), traffic: bounded(value.traffic_minutes_delay, 0, 100000)
    } : null;
    car.fields[field] = { value, receivedAt: now, liveAt: retained ? null : now };
    if (field === 'route_line' || field === 'active_route') {
      const line = car.fields.route_line?.value, destination = car.fields.active_route;
      if (lineMatchesDestination(line, destination)) car.visibleRouteLine = line;
      // Keep matching geometry while a replacement or clear waits for TeslaMate.
      // A source with no TeslaMate navigation metadata can still clear directly.
      else if (!lineMatchesDestination(car.visibleRouteLine, destination) || (!line && !destination?.value)) car.visibleRouteLine = null;
    }
    this.cars.set(id, car);
    this.emit('update', id);
  }
  snapshot(id, now = Date.now()) {
    const car = this.cars.get(id);
    if (!car) return { id, connected: this.connected, waiting: true };
    const get = field => car.fields[field]?.value ?? null;
    const fresh = field => this.connected && car.fields[field]?.liveAt != null && now - car.fields[field].liveAt < 120000;
    const route = get('active_route');
    return { id, connected: this.connected, name: get('display_name') || `Tesla ${id}`, state: get('state'),
      healthy: get('healthy'), speed: get('speed'), heading: get('heading'), battery: get('battery_level'),
      location: get('location'), route, routeLine: car.visibleRouteLine?.encoded ?? null, locationFresh: fresh('location'), speedFresh: fresh('speed'), routeFresh: fresh('active_route'),
      locationReceivedAt: car.fields.location?.receivedAt ?? null,
      locationLiveAt: car.fields.location?.liveAt ?? null,
      arrivalAt: route?.minutes != null && fresh('active_route') ? car.fields.active_route.liveAt + route.minutes * 60000 : null };
  }
}
