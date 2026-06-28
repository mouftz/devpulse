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
  appSlug: string | undefined
}

const requiredEnv = (name: string) => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

const normalizeKey = (raw: string) => raw.replace(/\\n/g, '\n').trim()

export const normalizeAppSlug = (raw?: string | null) => {
  const value = raw?.trim()
  if (!value) return undefined

  try {
    const url = new URL(value)
    const appSlug = url.pathname.match(/^\/apps\/([^/]+)/)?.[1]
    if (appSlug) return appSlug
  } catch {
    // Plain slugs and GitHub App display names are handled below.
  }

  return value
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || undefined
}

const appSlugForTier = (tier: AccessTier, raw?: string | null) => {
  const slug = normalizeAppSlug(raw)
  if (tier === 'standard' && slug === 'devpulse-analytics') {
    return 'devpulse-analytics-standard'
  }
  return slug
}

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
    appSlug: appSlugForTier('standard', process.env.GITHUB_APP_SLUG),
  }),
  full: () => ({
    appId: requiredEnv('GITHUB_APP_FULL_ID'),
    privateKey: normalizeKey(requiredEnv('GITHUB_APP_FULL_PRIVATE_KEY')),
    webhookSecret: requiredEnv('GITHUB_APP_FULL_WEBHOOK_SECRET'),
    clientId: requiredEnv('GITHUB_APP_FULL_CLIENT_ID'),
    clientSecret: requiredEnv('GITHUB_APP_FULL_CLIENT_SECRET'),
    appSlug: normalizeAppSlug(process.env.GITHUB_APP_FULL_SLUG),
  }),
}

export const getAppCredentials = (tier: AccessTier): AppCredentials => credentialsByTier[tier]()

export const getAppSlug = (tier: AccessTier) =>
  appSlugForTier(tier, tier === 'standard' ? process.env.GITHUB_APP_SLUG : process.env.GITHUB_APP_FULL_SLUG)

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
