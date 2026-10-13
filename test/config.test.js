import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.js';

test('Cloudflare remains the default; external auth is explicit and still requires HTTPS', () => {
  const cloudflare = loadConfig({ PUBLIC_ORIGIN: 'https://eta.example.com', CF_ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com', CF_ACCESS_ADMIN_AUD: 'audience' });
  assert.equal(cloudflare.adminAuthMode, 'cloudflare');
  const config = loadConfig({ PUBLIC_ORIGIN: 'https://eta.example.com', ADMIN_AUTH_MODE: 'external' });
  assert.equal(config.adminAuthMode, 'external');
  assert.equal(config.accessIssuer, undefined);
  assert.throws(() => loadConfig({ PUBLIC_ORIGIN: 'https://eta.example.com' }), /CF_ACCESS_TEAM_DOMAIN/);
  assert.throws(() => loadConfig({ PUBLIC_ORIGIN: 'http://eta.example.com', ADMIN_AUTH_MODE: 'external' }), /HTTPS/);
  assert.throws(() => loadConfig({ PUBLIC_ORIGIN: 'https://eta.example.com', ADMIN_AUTH_MODE: 'none' }), /ADMIN_AUTH_MODE/);
});
