const api = 'https://api.github.com/repos/DennisGarvey/TeslaETA';
const validCommit = value => /^[a-f0-9]{40}$/i.test(value || '');

export async function checkForUpdates(commit, fetchImpl = fetch) {
  if (!validCommit(commit)) return { available: false, status: 'unversioned' };
  async function request(path) {
    const response = await fetchImpl(`${api}${path}`, {
      headers: { Accept: 'application/vnd.github+json' },
      cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(5000), redirect: 'error'
    });
    if (!response.ok) throw new Error('Update check unavailable');
    return response.json();
  }
  try {
    // Wait until the container has published, rather than just seeing a new commit.
    const data = await request('/actions/workflows/container.yml/runs?branch=main&status=success&per_page=1');
    const run = data.workflow_runs?.[0];
    if (run?.conclusion !== 'success' || run.head_branch !== 'main' || !validCommit(run.head_sha)) throw new Error('No published build');
    const latestCommit = run.head_sha.toLowerCase();
    let available = false;
    if (latestCommit !== commit) {
      const comparison = await request(`/compare/${commit}...${latestCommit}`);
      if (!['ahead', 'behind', 'identical', 'diverged'].includes(comparison.status)) throw new Error('Invalid comparison');
      available = comparison.status === 'ahead';
    }
    return { available, latestCommit, status: available ? 'available' : 'current' };
  } catch {
    return { available: false, status: 'unavailable' };
  }
}
