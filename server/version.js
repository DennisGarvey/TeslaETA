export function readVersion(env = process.env) {
  const valid = value => /^[a-f0-9]{40}$/i.test(value || '');
  return { commit: valid(env.APP_COMMIT) ? env.APP_COMMIT.toLowerCase() : null };
}

export const runningVersion = readVersion();
