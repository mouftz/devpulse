import test from 'node:test'
import assert from 'node:assert/strict'
import {
  compareToWorkspaceAverage,
  filterManagerRepos,
  getQueueNotice,
  getSyncHealthSummary,
  getSyncStatusLabel,
  matchesSyncFilter,
  summarizeManagerRepos,
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

test('filterManagerRepos combines search, status, and visibility filters', () => {
  const repos = [
    { fullName: 'mouftz/resume', provider: 'github', isHidden: false, syncStatus: 'healthy' },
    { fullName: 'iqbank/iqbank', provider: 'gitea', isHidden: true, syncStatus: 'failed' },
    { fullName: 'mouftz/devpulse', provider: 'github', isHidden: false, syncStatus: 'queued' },
  ]

  assert.deepEqual(
    filterManagerRepos(repos, 'mouftz', 'all', 'visible').map((repo) => repo.fullName),
    ['mouftz/resume', 'mouftz/devpulse'],
  )
  assert.deepEqual(
    filterManagerRepos(repos, '', 'failed', 'hidden').map((repo) => repo.fullName),
    ['iqbank/iqbank'],
  )
  assert.deepEqual(
    filterManagerRepos(repos, 'gitea', 'all', 'all').map((repo) => repo.fullName),
    ['iqbank/iqbank'],
  )
})

test('summarizeManagerRepos counts visibility and per-status totals', () => {
  const summary = summarizeManagerRepos([
    { isHidden: false, syncStatus: 'healthy' },
    { isHidden: true, syncStatus: 'failed' },
    { isHidden: false, syncStatus: 'queued' },
    { isHidden: false, syncStatus: 'healthy' },
  ])

  assert.deepEqual(summary, {
    visible: 3,
    hidden: 1,
    statuses: {
      healthy: 2,
      queued: 1,
      syncing: 0,
      failed: 1,
      idle: 0,
    },
  })
})

test('compareToWorkspaceAverage provides useful relative context', () => {
  assert.deepEqual(compareToWorkspaceAverage(15, 50, 5), {
    average: 10,
    label: '50% above average',
    tone: 'above',
  })
  assert.equal(compareToWorkspaceAverage(5, 50, 5).label, '50% below average')
  assert.equal(compareToWorkspaceAverage(0, 0, 5).label, 'At workspace average')
  assert.equal(compareToWorkspaceAverage(4, 0, 0).label, 'Only active repository')
})
