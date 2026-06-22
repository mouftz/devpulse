/**
 * DevPulse runs TWO separate GitHub Apps, each with a different permission
 * footprint. Users explicitly choose which one to install via /connect.
 *
 *   "standard" — Pull requests, reviews, comments. NO code access.
 *   "full"     — Everything standard has, PLUS Contents: Read-only,
 *                which unlocks commit-level data via push webhooks.
 *
 * This module centralizes which App ID / private key / webhook secret
 * to use for a given tier, so the rest of the codebase never has to
 * think about which App is "active" — it just asks for the tier.
 */

export type AccessTier = 'standard' | 'full'

type AppCredentials = {
  appId: string
  privateKey: string
  webhookSecret: string
  clientId: string
  clientSecret: string
}

const requiredEnv = (name: string) => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

const normalizeKey = (raw: string) => raw.replace(/\\n/g, '\n').trim()

// NOTE: "standard" reuses the ORIGINAL unprefixed env vars (the app that
// already existed before the two-tier split). Only "full" got new,
// explicitly suffixed vars when it was added. This avoids a rename of
// every existing env var on Render.
const credentialsByTier: Record<AccessTier, () => AppCredentials> = {
  standard: () => ({
    appId: requiredEnv('GITHUB_APP_ID'),
    privateKey: normalizeKey(requiredEnv('GITHUB_APP_PRIVATE_KEY')),
    webhookSecret: requiredEnv('GITHUB_APP_WEBHOOK_SECRET'),
    clientId: requiredEnv('GITHUB_CLIENT_ID'),
    clientSecret: requiredEnv('GITHUB_CLIENT_SECRET'),
  }),
  full: () => ({
    appId: requiredEnv('GITHUB_APP_FULL_ID'),
    privateKey: normalizeKey(requiredEnv('GITHUB_APP_FULL_PRIVATE_KEY')),
    webhookSecret: requiredEnv('GITHUB_APP_FULL_WEBHOOK_SECRET'),
    clientId: requiredEnv('GITHUB_APP_FULL_CLIENT_ID'),
    clientSecret: requiredEnv('GITHUB_APP_FULL_CLIENT_SECRET'),
  }),
}

export const getAppCredentials = (tier: AccessTier): AppCredentials => credentialsByTier[tier]()

// Feature flags derived purely from tier — used by the UI and the
// feature extractor to know what's available without re-deriving logic
// in multiple places.
export const tierCapabilities: Record<AccessTier, {
  commitData: boolean
  pushWebhooks: boolean
  label: string
  description: string
}> = {
  standard: {
    commitData: false,
    pushWebhooks: false,
    label: 'Standard',
    description: 'PR cycle time, review latency, and comment activity. DevPulse never requests access to your source code.',
  },
  full: {
    commitData: true,
    pushWebhooks: true,
    label: 'Full',
    description: 'Everything in Standard, plus commit-level metrics: commit frequency, late-night/weekend activity, and richer burnout signals.',
  },
}
