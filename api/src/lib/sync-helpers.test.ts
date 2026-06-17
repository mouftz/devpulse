import test from 'node:test'
import assert from 'node:assert/strict'
import { dueSyncCutoff, providerFromRepoId } from './sync-helpers.js'

test('providerFromRepoId detects gitea and github ids', () => {
  assert.equal(providerFromRepoId('gitea:123'), 'gitea')
  assert.equal(providerFromRepoId('145159681'), 'github')
})

test('dueSyncCutoff subtracts the expected number of hours', () => {
  const now = new Date('2026-06-17T12:00:00.000Z')
  assert.equal(dueSyncCutoff(now, 24).toISOString(), '2026-06-16T12:00:00.000Z')
})
