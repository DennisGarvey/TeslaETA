import test from 'node:test';
import assert from 'node:assert/strict';
import { readVersion } from '../server/version.js';

const commit = 'abcdef0123'.repeat(4);
test('container version comes from the built image without consulting git', () => {
  assert.deepEqual(readVersion({ APP_COMMIT: commit }), { commit });
  assert.deepEqual(readVersion({ APP_COMMIT: '<invalid>' }), { commit: null });
});
test('build commit is normalized and unversioned installs do not claim a version', () => {
  assert.deepEqual(readVersion({ APP_COMMIT: commit.toUpperCase() }), { commit });
  assert.deepEqual(readVersion({}), { commit: null });
});
