export const routeLineMaxBytes = 256 * 1024;
const maxPoints = 50000;
const radians = Math.PI / 180;
const earthRadius = 6371000;
const wrap = degrees => ((degrees + 180) % 360 + 360) % 360 - 180;

function unwrapPolyline(bytes) {
  let offset = 0, polyline = null;
  function varint() {
    let result = 0;
    for (let group = 0; group < 5; group++) {
      if (offset >= bytes.length) throw new Error('Incomplete field');
      const byte = bytes.charCodeAt(offset++);
      result += (byte & 127) * 2 ** (group * 7);
      if (result > 0xffffffff) throw new Error('Field overflow');
      if (byte < 128) return result;
    }
    throw new Error('Field overflow');
  }
  while (offset < bytes.length) {
    const tag = varint(), field = Math.floor(tag / 8), wire = tag % 8;
    if (!field || (field === 1 && wire !== 2)) throw new Error('Invalid field');
    if (wire === 2) {
      const length = varint();
      if (length > bytes.length - offset) throw new Error('Incomplete field');
      if (field === 1) {
        if (polyline !== null) throw new Error('Duplicate polyline');
        polyline = bytes.slice(offset, offset + length);
      }
      offset += length;
    } else if (wire === 0) {
      let ended = false;
      for (let group = 0; group < 10; group++) {
        if (offset >= bytes.length) throw new Error('Incomplete field');
        const byte = bytes.charCodeAt(offset++);
        if (group === 9 && byte > 1) throw new Error('Field overflow');
        if (byte < 128) { ended = true; break; }
      }
      if (!ended) throw new Error('Field overflow');
    } else if (wire === 1 || wire === 5) {
      offset += wire === 1 ? 8 : 4;
      if (offset > bytes.length) throw new Error('Incomplete field');
    } else throw new Error('Unsupported field');
  }
  return polyline;
}

export function decodeRouteLine(value) {
  if (typeof value !== 'string' || !value.length || value.length > routeLineMaxBytes || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  let encoded;
  try {
    encoded = atob(value);
    if (!/^[?-~]+$/.test(encoded)) encoded = unwrapPolyline(encoded);
    if (!encoded) return null;
  } catch { return null; }
  let index = 0, latitude = 0, longitude = 0;
  const points = [];
  function delta() {
    let result = 0, factor = 1;
    for (let group = 0; group < 7; group++) {
      if (index >= encoded.length) throw new Error('Incomplete coordinate');
      const byte = encoded.charCodeAt(index++) - 63;
      if (byte < 0 || byte > 63) throw new Error('Invalid coordinate');
      result += (byte & 31) * factor;
      if (result > 0x7fffffff) throw new Error('Coordinate overflow');
      if (byte < 32) return result % 2 ? -(Math.floor(result / 2) + 1) : result / 2;
      factor *= 32;
    }
    throw new Error('Coordinate overflow');
  }
  try {
    while (index < encoded.length) {
      latitude += delta(); longitude += delta();
      if (Math.abs(latitude) > 90000000 || Math.abs(longitude) > 180000000 || points.length >= maxPoints) return null;
      points.push([latitude / 1e6, longitude / 1e6]);
    }
  } catch { return null; }
  return points.length >= 2 ? points : null;
}

export function distanceMeters(a, b) {
  const lat = (b[0] - a[0]) * radians, lng = wrap(b[1] - a[1]) * radians;
  const h = Math.sin(lat / 2) ** 2 + Math.cos(a[0] * radians) * Math.cos(b[0] * radians) * Math.sin(lng / 2) ** 2;
  return 2 * earthRadius * Math.asin(Math.sqrt(Math.min(1, h)));
}

export function alignRoutePoint(point, longitude) {
  return [point[0], point[1] + 360 * Math.round((longitude - point[1]) / 360)];
}

function project(point, a, b, minFraction = 0, maxFraction = 1) {
  const scale = Math.cos((a[0] + b[0]) / 2 * radians);
  const x = (b[1] - a[1]) * radians * earthRadius * scale;
  const y = (b[0] - a[0]) * radians * earthRadius;
  const px = wrap(point[1] - a[1]) * radians * earthRadius * scale;
  const py = (point[0] - a[0]) * radians * earthRadius;
  const fraction = Math.max(minFraction, Math.min(maxFraction, x || y ? (px * x + py * y) / (x * x + y * y) : 0));
  return { fraction, distance: Math.hypot(px - x * fraction, py - y * fraction), bearing: Math.atan2(x, y) / radians };
}

export class RouteProgress {
  constructor() { this.encoded = null; this.points = null; this.view = null; }
  update(encoded, position, { heading, timestamp, speed, remainingMiles, destination } = {}) {
    if (encoded !== this.encoded) {
      this.encoded = encoded;
      this.points = decodeRouteLine(encoded);
      this.progress = 0; this.initialized = false; this.lastPosition = null; this.lastTimestamp = null;
      this.view = null;
      if (this.points) {
        for (let i = 1; i < this.points.length; i++) this.points[i] = alignRoutePoint(this.points[i], this.points[i - 1][1]);
        this.distances = [0];
        for (let i = 1; i < this.points.length; i++) this.distances.push(this.distances[i - 1] + distanceMeters(this.points[i - 1], this.points[i]));
      }
    }
    if (!this.points) return null;
    if (this.view && (!position || (position[0] === this.lastPosition?.[0] && position[1] === this.lastPosition?.[1]))) return this.view;
    const total = this.distances.at(-1);
    if (position) {
      const moved = this.lastPosition ? distanceMeters(this.lastPosition, position) : 0;
      const elapsed = this.lastTimestamp != null && Number.isFinite(timestamp) ? Math.max(0, (timestamp - this.lastTimestamp) / 1000) : 0;
      const advance = Math.max(250, moved * 3, elapsed * Math.max(Number(speed) / 3.6 || 0, 15) * 2);
      const limit = this.initialized ? Math.min(total, this.progress + advance) : total;
      const distanceMatches = Number.isFinite(remainingMiles) && (!destination || distanceMeters(this.points.at(-1), destination) <= 500);
      const expected = this.initialized ? this.progress + moved : distanceMatches ? Math.max(0, total - remainingMiles * 1609.344) : null;
      let best = null;
      for (let i = 0; i < this.points.length - 1; i++) {
        const start = this.distances[i], length = this.distances[i + 1] - start;
        if (this.distances[i + 1] < this.progress || start > limit) continue;
        const candidate = project(position, this.points[i], this.points[i + 1], length ? Math.max(0, (this.progress - start) / length) : 0, length ? Math.min(1, (limit - start) / length) : 1);
        const progress = start + length * candidate.fraction;
        // At crossings, prefer continuity and the direction of travel over a later leg.
        const continuity = expected == null ? 0 : Math.abs(progress - expected) * 0.05;
        const direction = Number.isFinite(heading) ? (1 - Math.cos((candidate.bearing - heading) * radians)) * 5 : 0;
        const score = candidate.distance + Math.min(12, continuity + direction);
        if (!best || score < best.score) best = { ...candidate, progress, score };
      }
      // Keep the remaining route when off-route rather than skipping distant legs.
      if (best && best.distance <= 150) { this.progress = Math.max(this.progress, best.progress); this.initialized = true; }
      this.lastPosition = position.slice();
      this.lastTimestamp = Number.isFinite(timestamp) ? timestamp : null;
    }
    let segment = 0;
    while (segment < this.points.length - 2 && this.distances[segment + 1] < this.progress) segment++;
    const length = this.distances[segment + 1] - this.distances[segment];
    const fraction = length ? (this.progress - this.distances[segment]) / length : 0;
    const a = this.points[segment], b = this.points[segment + 1];
    const cut = [a[0] + (b[0] - a[0]) * fraction, a[1] + (b[1] - a[1]) * fraction];
    this.view = {
      completed: this.progress > 0 ? [...this.points.slice(0, segment + 1), cut] : [],
      remaining: [cut, ...this.points.slice(segment + 1)]
    };
    return this.view;
  }
}
