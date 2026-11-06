import test from 'node:test';
import assert from 'node:assert/strict';
import { checkForUpdates } from '../public/updates.js';

const current = 'a'.repeat(40), latest = 'b'.repeat(40);
const run = sha => ({ workflow_runs: [{ head_sha: sha, head_branch: 'main', conclusion: 'success' }] });
const response = data => ({ ok: true, json: async () => data });

test('browser checks published builds, confirms ancestry and never caches requests', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push(url);
    assert.equal(options.cache, 'no-store');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.referrerPolicy, 'no-referrer');
    return response(url.includes('/compare/') ? { status: 'ahead' } : run(latest));
  };
  const update = await checkForUpdates(current, fetchImpl);
  assert.equal(update.available, true); assert.equal(update.latestCommit, latest);
  assert.ok(requests[0].includes('container.yml/runs?branch=main&status=success'));
  assert.ok(requests[1].endsWith(`/compare/${current}...${latest}`));
  await checkForUpdates(current, fetchImpl); assert.equal(requests.length, 4);
});

test('identical, newer-running and divergent builds do not advertise updates', async () => {
  let calls = 0;
  assert.equal((await checkForUpdates(current, async () => { calls++; return response(run(current)); })).available, false);
  assert.equal(calls, 1);
  for (const status of ['behind', 'identical', 'diverged']) {
    assert.equal((await checkForUpdates(current, async url => response(url.includes('/compare/') ? { status } : run(latest)))).available, false);
  }
});

test('unversioned instances skip requests and failed checks do not claim up-to-date', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('Offline'); };
  assert.equal((await checkForUpdates(null, fetchImpl)).status, 'unversioned'); assert.equal(calls, 0);
  assert.equal((await checkForUpdates(current, fetchImpl)).status, 'unavailable');
  await checkForUpdates(current, fetchImpl); assert.equal(calls, 2);
});

test('missing, failed or malformed published build metadata never produces a notice', async () => {
  for (const data of [{ workflow_runs: [] }, run('<invalid>'), { workflow_runs: [{ head_sha: latest, head_branch: 'main', conclusion: 'failure' }] }]) {
    assert.equal((await checkForUpdates(current, async () => response(data))).status, 'unavailable');
  }
});
