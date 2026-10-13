export function loadConfig(env = process.env) {
  const localPreview = env.LOCAL_PREVIEW === 'true';
  const adminAuthMode = env.ADMIN_AUTH_MODE || 'cloudflare';
  if (!['cloudflare', 'external'].includes(adminAuthMode)) throw new Error('ADMIN_AUTH_MODE must be cloudflare or external.');
  const port = Number(env.PORT || 3001);
  const origin = new URL(env.PUBLIC_ORIGIN || `http://localhost:${port}`);
  if (!localPreview && !env.PUBLIC_ORIGIN) throw new Error('Set PUBLIC_ORIGIN to the public HTTPS origin.');
  if (!localPreview && origin.protocol !== 'https:') throw new Error('PUBLIC_ORIGIN must use HTTPS.');
  const accessIssuer = adminAuthMode === 'cloudflare' ? env.CF_ACCESS_TEAM_DOMAIN?.replace(/\/$/, '') : undefined;
  const accessAudience = adminAuthMode === 'cloudflare' ? env.CF_ACCESS_ADMIN_AUD : undefined;
  if (!localPreview && adminAuthMode === 'cloudflare' && (!accessIssuer || !accessAudience)) throw new Error('Configure CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_ADMIN_AUD, or set ADMIN_AUTH_MODE=external when another service protects /admin.');
  if (accessIssuer && !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(accessIssuer)) throw new Error('Use your HTTPS cloudflareaccess.com team domain.');
  return { port, localPreview, adminAuthMode, publicOrigin: origin.origin, accessIssuer, accessAudience, mqttConfigured: !!env.MQTT_URL };
}
