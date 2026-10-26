import { writeSync } from 'node:fs';

export function createLogger({ now = () => new Date(), write = (line, level) => writeSync(level === 'INFO' ? 1 : 2, `${line}\n`) } = {}) {
  const log = (level, message, fields = {}) => {
    const details = Object.entries(fields).filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(' ');
    write(`${now().toISOString()} ${level} ${message}${details ? ` ${details}` : ''}`, level);
  };
  return {
    info: (message, fields) => log('INFO', message, fields),
    warn: (message, fields) => log('WARN', message, fields),
    error: (message, fields) => log('ERROR', message, fields)
  };
}

export const logger = createLogger();

const reasons = {
  ECONNREFUSED: 'Connection refused', ECONNRESET: 'Connection reset', EPIPE: 'Connection closed',
  ENOTFOUND: 'Broker hostname not found', EAI_AGAIN: 'DNS lookup failed temporarily',
  ETIMEDOUT: 'Connection timed out', EHOSTUNREACH: 'Host unreachable', ENETUNREACH: 'Network unreachable',
  EADDRINUSE: 'Port already in use', EACCES: 'Permission denied', EPERM: 'Operation not permitted',
  ENOENT: 'File or directory not found', ENOSPC: 'Disk full', EROFS: 'Filesystem is read-only',
  CERT_HAS_EXPIRED: 'TLS certificate expired', DEPTH_ZERO_SELF_SIGNED_CERT: 'TLS certificate is self-signed',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS certificate could not be verified',
  SELF_SIGNED_CERT_IN_CHAIN: 'TLS certificate chain contains a self-signed certificate',
  ERR_TLS_CERT_ALTNAME_INVALID: 'TLS certificate does not match the broker hostname',
  ERR_INVALID_URL: 'Invalid URL', ERR_SQLITE_ERROR: 'Database error'
};
const mqttReasons = { 1: 'Unsupported MQTT version', 2: 'MQTT client ID rejected', 3: 'Broker unavailable', 4: 'Broker credentials rejected', 5: 'Broker authorization rejected', 128: 'Broker rejected the connection', 132: 'Unsupported MQTT version', 133: 'MQTT client ID rejected', 134: 'Broker credentials rejected', 135: 'Broker authorization rejected', 136: 'Broker unavailable', 137: 'Broker busy', 151: 'Broker quota exceeded' };
const safeMessages = new Set([
  'ADMIN_AUTH_MODE must be cloudflare or external.',
  'Set PUBLIC_ORIGIN to the public HTTPS origin.', 'PUBLIC_ORIGIN must use HTTPS.',
  'Configure CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_ADMIN_AUD, or set ADMIN_AUTH_MODE=external when another service protects /admin.',
  'Use your HTTPS cloudflareaccess.com team domain.', 'Invalid sharing-link encryption key',
  'Sharing-link integrity check failed', 'connack timeout', 'Keepalive timeout',
  'Enter an MQTT URL.', 'Select an MQTT transport.', 'Enter a complete MQTT URL including its protocol.',
  'Use a ws:// or wss:// URL.', 'Use an mqtt:// or mqtts:// URL.',
  'Use a URL without credentials, query parameters, or a fragment. Enter broker credentials separately.',
  'Regular MQTT URLs do not use a WebSocket path.', 'Cloudflare service tokens require a secure wss:// connection.',
  'Broker username is too long.', 'Broker password is too long.', 'Token values must be text.',
  'Paste one token value per field.', 'Enter both Cloudflare service-token values.'
]);

// Library error messages and stacks may contain URLs, tokens, payloads or SQL.
// Only known reasons and numeric error codes are allowed into container logs.
export function errorDetails(error) {
  const code = error?.code;
  const message = typeof error?.message === 'string' ? error.message : '';
  if (typeof code === 'string' && Object.hasOwn(reasons, code)) {
    return { reason: reasons[code], code, ...(Number.isInteger(error.errcode) ? { sqliteCode: error.errcode } : {}) };
  }
  const mqttCode = error?.reasonCode ?? code;
  if (typeof mqttCode === 'number' && Object.hasOwn(mqttReasons, mqttCode)) return { reason: mqttReasons[mqttCode], mqttCode };
  if (safeMessages.has(message)) return { reason: message };
  const status = /^Unexpected server response: (\d{3})$/.exec(message);
  if (status) return { reason: 'WebSocket handshake rejected', httpStatus: Number(status[1]) };
  if (message === 'Unsupported state or unable to authenticate data') return { reason: 'Stored data could not be decrypted; check the database encryption key' };
  const source = typeof error?.stack === 'string' ? /server\/(?:app|config|index|logger|mqtt|read-only|sharing-settings|store|stream|telemetry|viewers)\.js:\d+(?=:\d+)/.exec(error.stack)?.[0] : undefined;
  return { reason: 'Unexpected error', ...(source ? { source } : {}) };
}
