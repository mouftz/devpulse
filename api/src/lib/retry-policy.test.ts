import assert from 'node:assert/strict'
import test from 'node:test'
import { isRetryableSyncError, retryDelayMs, shouldRetrySyncJob } from './retry-policy.js'

test('retryDelayMs applies bounded exponential backoff', () => {
  assert.equal(retryDelayMs(0, 1_000, 30_000), 1_000)
  assert.equal(retryDelayMs(1, 1_000, 30_000), 2_000)
  assert.equal(retryDelayMs(10, 1_000, 30_000), 30_000)
})

test('isRetryableSyncError skips credential and configuration failures', () => {
  assert.equal(isRetryableSyncError(new Error('GitHub token missing for repo owner/name')), false)
  assert.equal(isRetryableSyncError(new Error('GITEA_BASE_URL is required')), false)
  assert.equal(isRetryableSyncError(new Error('Connect GitHub before syncing repositories')), false)
  assert.equal(isRetryableSyncError(new Error('GitHub installation 123 does not belong to the standard app')), false)
  assert.equal(isRetryableSyncError(new Error('Request failed with 503')), true)
})

test('shouldRetrySyncJob stops after the configured attempt limit', () => {
  const transientError = new Error('Request timed out')
  assert.equal(shouldRetrySyncJob({ attempt: 0 }, transientError, 3), true)
  assert.equal(shouldRetrySyncJob({ attempt: 1 }, transientError, 3), true)
  assert.equal(shouldRetrySyncJob({ attempt: 2 }, transientError, 3), false)
})
