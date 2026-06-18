import assert from 'node:assert/strict'
import test from 'node:test'
import { parseSyncJob, popSyncJob, setQueueTransportForTests } from './sync-queue.js'

const validJob = {
  repoId: 'repo-1',
  provider: 'github',
  ownerId: 'user-1',
  reason: 'manual',
  requestedAt: '2026-06-18T12:00:00.000Z',
}

test('parseSyncJob accepts a complete queue payload', () => {
  assert.deepEqual(parseSyncJob(JSON.stringify(validJob)), validJob)
})

test('parseSyncJob rejects malformed JSON and invalid job fields', () => {
  assert.equal(parseSyncJob('{broken'), null)
  assert.equal(parseSyncJob(JSON.stringify({ ...validJob, provider: 'bitbucket' })), null)
  assert.equal(parseSyncJob(JSON.stringify({ ...validJob, repoId: '' })), null)
  assert.equal(parseSyncJob(JSON.stringify({ ...validJob, attempt: -1 })), null)
})

test('popSyncJob safely discards malformed queue entries', async () => {
  setQueueTransportForTests({
    push: async () => {},
    pop: async () => JSON.stringify({ repoId: 'repo-1' }),
    depth: async () => 1,
  })

  try {
    assert.equal(await popSyncJob(), null)
  } finally {
    setQueueTransportForTests(null)
  }
})
