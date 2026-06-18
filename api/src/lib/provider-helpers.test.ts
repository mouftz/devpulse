import assert from 'node:assert/strict'
import test from 'node:test'
import { legacyRepoKey, normalizeProviderRepoId } from './provider-helpers.js'

test('legacyRepoKey preserves github ids and namespaces gitea ids', () => {
  assert.equal(legacyRepoKey('github', '145159681'), '145159681')
  assert.equal(legacyRepoKey('gitea', '123'), 'gitea:123')
})

test('normalizeProviderRepoId prefers explicit provider ids and falls back to legacy keys', () => {
  assert.equal(normalizeProviderRepoId('88', 'gitea:123'), '88')
  assert.equal(normalizeProviderRepoId(undefined, 'gitea:123'), '123')
  assert.equal(normalizeProviderRepoId(null, '145159681'), '145159681')
  assert.equal(normalizeProviderRepoId(undefined, undefined), null)
})
