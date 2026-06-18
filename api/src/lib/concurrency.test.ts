import assert from 'node:assert/strict'
import test from 'node:test'
import { mapWithConcurrency } from './concurrency.js'

test('mapWithConcurrency preserves order and limits active work', async () => {
  let active = 0
  let peak = 0
  const results = await mapWithConcurrency([4, 3, 2, 1], 2, async (value) => {
    active += 1
    peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, value))
    active -= 1
    return value * 2
  })
  assert.deepEqual(results, [8, 6, 4, 2])
  assert.equal(peak, 2)
})

test('mapWithConcurrency handles empty input and clamps invalid limits', async () => {
  assert.deepEqual(await mapWithConcurrency([], 5, async (value) => value), [])
  assert.deepEqual(await mapWithConcurrency([1, 2], 0, async (value) => value), [1, 2])
})
