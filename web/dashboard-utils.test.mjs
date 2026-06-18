import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getQueueNotice,
  getSyncHealthSummary,
  getSyncStatusLabel,
  matchesSyncFilter,
} from './src/lib/dashboard-utils.js'

test('getSyncHealthSummary prefers queued work when jobs are pending', () => {
  assert.deepEqual(getSyncHealthSummary(3, 0), {
    value: '3 queued',
    detail: 'Background sync jobs waiting',
  })
})

test('getSyncStatusLabel renames idle to new', () => {
  assert.equal(getSyncStatusLabel('idle'), 'new')
  assert.equal(getSyncStatusLabel('failed'), 'failed')
})

test('getQueueNotice handles bulk and single repo queue copy', () => {
  assert.equal(
    getQueueNotice(3, 5),
    'Queued 3 repositories for background sync. 5 jobs waiting.',
  )
  assert.equal(
    getQueueNotice(1, 2, 'mouftz/resume'),
    'Queued mouftz/resume for background sync. 2 jobs waiting.',
  )
  assert.equal(
    getQueueNotice(0, 0, 'mouftz/resume'),
    'No sync job queued for mouftz/resume.',
  )
})

test('matchesSyncFilter handles real sync states and unsynced fallback', () => {
  const queuedRepo = { lastSyncedAt: null, syncStatus: 'queued' }
  const healthyRepo = { lastSyncedAt: '2026-06-17T12:00:00.000Z', syncStatus: 'healthy' }

  assert.equal(matchesSyncFilter(queuedRepo, 'all'), true)
  assert.equal(matchesSyncFilter(queuedRepo, 'queued'), true)
  assert.equal(matchesSyncFilter(queuedRepo, 'healthy'), false)
  assert.equal(matchesSyncFilter(queuedRepo, 'unsynced'), true)
  assert.equal(matchesSyncFilter(healthyRepo, 'unsynced'), false)
  assert.equal(matchesSyncFilter(healthyRepo, 'healthy'), true)
})
