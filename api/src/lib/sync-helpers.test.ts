import test from 'node:test'
import assert from 'node:assert/strict'
import { dueSyncCutoff, normalizeRepoProvider, providerFromRepoId, shouldEnqueueRepo } from './sync-helpers.js'

test('providerFromRepoId detects gitea and github ids', () => {
  assert.equal(providerFromRepoId('gitea:123'), 'gitea')
  assert.equal(providerFromRepoId('145159681'), 'github')
})

test('normalizeRepoProvider prefers explicit provider and falls back to legacy ids', () => {
  assert.equal(normalizeRepoProvider('gitea', '145159681'), 'gitea')
  assert.equal(normalizeRepoProvider('github', 'gitea:123'), 'github')
  assert.equal(normalizeRepoProvider(undefined, 'gitea:123'), 'gitea')
  assert.equal(normalizeRepoProvider(null, '145159681'), 'github')
})

test('dueSyncCutoff subtracts the expected number of hours', () => {
  const now = new Date('2026-06-17T12:00:00.000Z')
  assert.equal(dueSyncCutoff(now, 24).toISOString(), '2026-06-16T12:00:00.000Z')
})

test('shouldEnqueueRepo skips queued and syncing repos', () => {
  assert.equal(
    shouldEnqueueRepo({
      lastSyncedAt: null,
      syncStatus: 'queued',
    }),
    false,
  )
  assert.equal(
    shouldEnqueueRepo({
      lastSyncedAt: new Date('2026-06-10T12:00:00.000Z'),
      syncStatus: 'syncing',
    }),
    false,
  )
})

test('shouldEnqueueRepo queues unsynced and stale repos only', () => {
  const now = new Date('2026-06-17T12:00:00.000Z')
  assert.equal(
    shouldEnqueueRepo({
      lastSyncedAt: null,
      syncStatus: 'idle',
      now,
    }),
    true,
  )
  assert.equal(
    shouldEnqueueRepo({
      lastSyncedAt: new Date('2026-06-16T10:59:59.000Z'),
      syncStatus: 'healthy',
      now,
    }),
    true,
  )
  assert.equal(
    shouldEnqueueRepo({
      lastSyncedAt: new Date('2026-06-16T13:00:00.000Z'),
      syncStatus: 'healthy',
      now,
    }),
    false,
  )
})
