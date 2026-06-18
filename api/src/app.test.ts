import assert from 'node:assert/strict'
import test from 'node:test'
import { createApp } from './app.js'

test('GET /health returns ok', async () => {
  const app = createApp()
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
    })

    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { status: 'ok' })
  } finally {
    await app.close()
  }
})

test('GET /auth/me rejects missing session', async () => {
  const app = createApp()
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/auth/me',
    })

    assert.equal(response.statusCode, 401)
    assert.deepEqual(response.json(), { error: 'Not authenticated' })
  } finally {
    await app.close()
  }
})

test('GET /auth/me rejects invalid session cookie', async () => {
  const app = createApp()
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/auth/me',
      cookies: {
        devpulse_token: 'not-a-real-token',
      },
    })

    assert.equal(response.statusCode, 401)
    assert.deepEqual(response.json(), { error: 'Invalid session' })
  } finally {
    await app.close()
  }
})

test('POST /auth/logout clears the session cookie', async () => {
  const app = createApp()
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/logout',
    })

    const setCookie = Array.isArray(response.headers['set-cookie'])
      ? response.headers['set-cookie'].join(';')
      : (response.headers['set-cookie'] ?? '')

    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { message: 'Logged out' })
    assert.match(setCookie, /devpulse_token=;/)
  } finally {
    await app.close()
  }
})
