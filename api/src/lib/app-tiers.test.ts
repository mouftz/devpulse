import assert from 'node:assert/strict'
import test from 'node:test'
import { getAppSlug, normalizeAppSlug } from './app-tiers.js'

test('normalizeAppSlug accepts slugs, display names, and copied GitHub App URLs', () => {
  assert.equal(normalizeAppSlug('devpulse-analytics-standard'), 'devpulse-analytics-standard')
  assert.equal(normalizeAppSlug('Devpulse Analytics Standard'), 'devpulse-analytics-standard')
  assert.equal(normalizeAppSlug('https://github.com/apps/devpulse-analytics-standard/installations/new'), 'devpulse-analytics-standard')
})

test('normalizeAppSlug returns undefined for empty values', () => {
  assert.equal(normalizeAppSlug(undefined), undefined)
  assert.equal(normalizeAppSlug('   '), undefined)
})

test('getAppSlug maps the legacy Standard slug to the Standard GitHub App', () => {
  const previousSlug = process.env.GITHUB_APP_SLUG
  process.env.GITHUB_APP_SLUG = 'devpulse-analytics'

  try {
    assert.equal(getAppSlug('standard'), 'devpulse-analytics-standard')
  } finally {
    if (previousSlug === undefined) delete process.env.GITHUB_APP_SLUG
    else process.env.GITHUB_APP_SLUG = previousSlug
  }
})
