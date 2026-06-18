import assert from 'node:assert/strict'
import test from 'node:test'
import { randomBytes } from 'node:crypto'
import { decryptToken, encryptToken } from './token-crypto.js'

test('provider tokens round-trip through AES-GCM encryption', () => {
  const previous = process.env.TOKEN_ENCRYPTION_KEY
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('base64')
  try {
    const encrypted = encryptToken('github-secret-token')
    assert.match(encrypted, /^enc:v1:/)
    assert.notEqual(encrypted, 'github-secret-token')
    assert.equal(decryptToken(encrypted), 'github-secret-token')
  } finally {
    if (previous === undefined) delete process.env.TOKEN_ENCRYPTION_KEY
    else process.env.TOKEN_ENCRYPTION_KEY = previous
  }
})

test('legacy plaintext tokens remain readable during local migration', () => {
  assert.equal(decryptToken('legacy-token'), 'legacy-token')
})
