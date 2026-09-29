import { EventEmitter } from 'node:events';

// Count active viewer streams, not page loads or unique people.
export class Viewers extends EventEmitter {
  constructor() { super(); this.setMaxListeners(0); this.counts = new Map(); }
  snapshot() { return Object.fromEntries(this.counts); }
  count(id) { return this.counts.get(id) || 0; }
  join(id) {
    this.counts.set(id, this.count(id) + 1); this.emit('change');
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const remaining = this.count(id) - 1;
      if (remaining > 0) this.counts.set(id, remaining); else this.counts.delete(id);
      this.emit('change');
    };
  }
}

export function streamViewers(req, res, viewers, telemetry, configured) {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no' });
  res.flushHeaders(); res.write('retry: 1000\n\n');
  let closed = false, heartbeat, reauthorize, pendingVehicles;
  function cleanup() {
    if (closed) return;
    closed = true; clearInterval(heartbeat); clearTimeout(reauthorize); clearTimeout(pendingVehicles);
    viewers.off('change', send); telemetry.off('connection', onConnection); telemetry.off('update', scheduleVehicles);
  }
  function send() {
    if (!closed && !res.write(`event: viewers\ndata: ${JSON.stringify(viewers.snapshot())}\n\n`)) { cleanup(); res.end(); }
  }
  function sendConnection() {
    if (!closed && !res.write(`event: connection\ndata: ${JSON.stringify({ connected: telemetry.connected, configured: !!configured() })}\n\n`)) { cleanup(); res.end(); }
  }
  function sendVehicles() {
    pendingVehicles = null;
    if (closed) return;
    const cars = [...telemetry.cars.keys()].map(id => {
      const { name, state, speed, speedFresh, location, locationFresh, locationLiveAt, heading } = telemetry.snapshot(id);
      return { id, name, state, speed, speedFresh, location, locationFresh, locationLiveAt, heading };
    });
    if (!res.write(`event: vehicles\ndata: ${JSON.stringify(cars)}\n\n`)) { cleanup(); res.end(); }
  }
  function scheduleVehicles() { if (!closed && !pendingVehicles) pendingVehicles = setTimeout(sendVehicles, 150); }
  function onConnection() { sendConnection(); scheduleVehicles(); }
  res.on('close', cleanup);
  viewers.on('change', send);
  telemetry.on('connection', onConnection);
  telemetry.on('update', scheduleVehicles);
  heartbeat = setInterval(send, 15000);
  // Reconnect periodically through the admin authentication middleware and
  // never keep a stream alive past the Access JWT's expiration.
  const lifetime = Math.min(60000, req.accessExpiresAt ? Math.max(0, req.accessExpiresAt - Date.now()) : 60000);
  reauthorize = setTimeout(() => { cleanup(); res.end(); }, lifetime);
  send(); sendConnection(); sendVehicles();
}
