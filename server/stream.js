// Only sanitized snapshots for the link's car are pushed; MQTT stays private.
export function streamShare(req, res, { telemetry, store, config, viewers }) {
  const token = req.params.token;
  let pending, heartbeat, leave, closed = false;
  const resolve = () => /^[A-Za-z0-9_-]{43}$/.test(token) ? store.resolve(token) : null;
  const initial = resolve();
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  function cleanup() {
    if (closed) return;
    closed = true;
    clearTimeout(pending); clearInterval(heartbeat);
    telemetry.off('update', onUpdate); telemetry.off('connection', schedule);
    store.off('revoke', checkAccess);
    leave?.();
  }
  function end() { if (!closed) { res.write('event: ended\ndata: {}\n\n'); cleanup(); res.end(); } }
  function checkAccess() { if (!resolve()) end(); }
  function send() {
    pending = null;
    if (closed) return;
    const share = resolve();
    if (!share) return end();
    const data = { ...telemetry.snapshot(share.car_id), expiresAt: share.expires_at, localPreview: config.localPreview };
    // Disconnect slow consumers rather than accumulate unbounded snapshots.
    if (!res.write(`event: snapshot\ndata: ${JSON.stringify(data)}\n\n`)) { cleanup(); res.end(); }
  }
  function schedule() { if (!closed && !pending) pending = setTimeout(send, 150); }
  function onUpdate(id) { if (id === initial?.car_id) schedule(); }
  res.on('close', cleanup);
  if (!initial) return end();
  leave = viewers?.join(initial.id);
  telemetry.on('update', onUpdate); telemetry.on('connection', schedule);
  store.on('revoke', checkAccess);
  // Check expiry every second, refresh age-based states and keep proxies alive
  // every 15 seconds, even when the vehicle publishes nothing.
  let ticks = 0;
  heartbeat = setInterval(() => { checkAccess(); if (!closed && ++ticks % 15 === 0) schedule(); }, 1000);
  send();
}
