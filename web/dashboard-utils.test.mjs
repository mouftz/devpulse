import test from 'node:test'
import assert from 'node:assert/strict'
import { getSyncHealthSummary, getSyncStatusLabel } from './src/lib/dashboard-utils.js'

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
