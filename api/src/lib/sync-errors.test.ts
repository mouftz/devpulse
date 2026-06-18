import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeSyncError } from './sync-errors.js'

test('normalizeSyncError maps provider status codes to clearer copy', () => {
  const error = new Error('Request failed')
  Reflect.set(error, 'response', { statusCode: 403 })
  assert.equal(normalizeSyncError(error), 'Provider authentication failed')
})

test('normalizeSyncError trims long plain error messages', () => {
  const longMessage = 'x'.repeat(500)
  assert.match(normalizeSyncError(new Error(longMessage)), /^x+\.\.\.$/)
})

test('normalizeSyncError falls back cleanly', () => {
  assert.equal(normalizeSyncError('boom'), 'boom')
  assert.equal(normalizeSyncError(null), 'Unknown sync error')
})
