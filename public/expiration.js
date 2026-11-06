// Shared by the browser and server so validation stays consistent.
export function resolveExpiration(input, now = Date.now()) {
  const { hours, expiresAt } = input || {};
  if (expiresAt === undefined && (!Number.isFinite(hours) || hours < 1 / 60)) return { error: 'Enter a duration of at least 1 minute.' };
  const expiry = expiresAt !== undefined ? expiresAt : Math.round(now + hours * 3600000);
  if (!Number.isSafeInteger(expiry)) return { error: 'Choose a valid end time.' };
  if (expiry <= now) return { error: 'Choose an end time in the future.' };
  if (expiry > now + 7 * 86400000) return { error: 'Expiration must be within 7 days from now.' };
  return { expiresAt: expiry, error: null };
}
