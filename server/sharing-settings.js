export function normalizeSharingOrigin(value, localPreview = false) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Enter a complete public URL.');
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('Enter a complete URL such as https://eta.example.com.'); }
  const localHttp = localPreview && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !localHttp) throw new Error('Use HTTPS for public sharing links.');
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Enter only the origin, without a path, credentials, query, or fragment.');
  return url.origin;
}
