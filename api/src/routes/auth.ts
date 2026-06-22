import type { FastifyInstance } from 'fastify'
import got from 'got'
import prisma from '../db.js'
import { encryptToken } from '../lib/token-crypto.js'
import { getQueueDepth } from '../lib/sync-queue.js'
import {
  exchangeInstallationToken,
  storeInstallationToken,
  uninstallGitHubAppInstallation,
} from '../lib/github-app.js'
import { getAppCredentials, type AccessTier } from '../lib/app-tiers.js'

type GitHubTokenResponse = {
  access_token: string
  token_type: string
  scope: string
}

type GitHubUser = {
  id: number
  login: string
  avatar_url: string | null
  email: string | null
}

type GitHubEmail = {
  email: string
  primary: boolean
  verified: boolean
}

const requiredEnv = (name: string) => {
  const value = process.env[name]
  if (!value) {
    throw new Error(`${name} is required`)
  }
  return value
}

const callbackUrl = (tier: AccessTier) =>
  process.env.NODE_ENV === 'production'
    ? `https://devpulse-api-naye.onrender.com/auth/github/callback/${tier}`
    : `http://localhost:3000/auth/github/callback/${tier}`

const frontendUrl = () => process.env.FRONTEND_URL ?? 'http://localhost:5173'

const isValidTier = (value: string): value is AccessTier =>
  value === 'standard' || value === 'full'

export async function authRoutes(app: FastifyInstance) {
  // ── Kick off OAuth login (tier-specific, since each App has its own
  //    client_id/client_secret used for the user-identity exchange) ──────────
  app.get<{ Params: { tier: string } }>('/github/:tier', async (request, reply) => {
    const { tier } = request.params
    if (!isValidTier(tier)) {
      return reply.code(400).send({ error: 'Unknown access tier' })
    }

    const { clientId } = getAppCredentials(tier)
    const state = crypto.randomUUID()
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: callbackUrl(tier),
      scope: 'read:user user:email',
      state,
    })

    return reply.redirect(`https://github.com/login/oauth/authorize?${params}`)
  })

  // ── OAuth + installation callback, now tier-aware via the route path ──────
  app.get<{
    Params: { tier: string }
    Querystring: { code?: string; error?: string; error_description?: string; installation_id?: string }
  }>('/github/callback/:tier', async (request, reply) => {
    const { tier } = request.params
    if (!isValidTier(tier)) {
      return reply.code(400).send({ error: 'Unknown access tier' })
    }

    if (request.query.error) {
      return reply.code(400).send({
        error: request.query.error,
        message: request.query.error_description ?? 'GitHub sign-in failed',
      })
    }

    const installationIdOnly = request.query.installation_id?.trim()

    // Case 1: user already signed in, this is just an App-install redirect
    // (no OAuth `code`, only `installation_id`)
    if (installationIdOnly && !request.query.code) {
      const token = request.cookies.devpulse_token

      if (!token) {
        const redirectUrl = new URL(frontendUrl())
        redirectUrl.searchParams.set('error', 'sign-in-required')
        return reply.redirect(redirectUrl.toString())
      }

      try {
        const payload = app.jwt.verify<{ sub: string }>(token)
        await storeInstallationToken(payload.sub, installationIdOnly, tier)

        const redirectUrl = new URL(frontendUrl())
        redirectUrl.searchParams.set('connected', tier)
        return reply.redirect(redirectUrl.toString())
      } catch {
        return reply.code(401).send({ error: 'Invalid session' })
      }
    }

    // Case 2: full OAuth login flow
    if (!request.query.code) {
      return reply.code(400).send({ error: 'Missing GitHub authorization code' })
    }

    const { clientId, clientSecret } = getAppCredentials(tier)

    const tokenResponse = await got
      .post('https://github.com/login/oauth/access_token', {
        json: {
          client_id: clientId,
          client_secret: clientSecret,
          code: request.query.code,
          redirect_uri: callbackUrl(tier),
        },
        headers: { Accept: 'application/json' },
      })
      .json<GitHubTokenResponse>()

    const githubUser = await got
      .get('https://api.github.com/user', {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${tokenResponse.access_token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      })
      .json<GitHubUser>()

    const emails = await got
      .get('https://api.github.com/user/emails', {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${tokenResponse.access_token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      })
      .json<GitHubEmail[]>()

    const primaryEmail = emails.find((email) => email.primary && email.verified)
    const email =
      githubUser.email ??
      primaryEmail?.email ??
      `${githubUser.id}+${githubUser.login}@users.noreply.github.com`

    const installationId = request.query.installation_id?.trim() || null
    const installationToken = installationId
      ? await exchangeInstallationToken(installationId, tier)
      : null

    const user = await prisma.user.upsert({
      where: { githubId: String(githubUser.id) },
      create: {
        githubId: String(githubUser.id),
        email,
        username: githubUser.login,
        avatarUrl: githubUser.avatar_url,
        accessToken: encryptToken(tokenResponse.access_token),
        accessTier: tier,
        ...(installationId && installationToken
          ? {
              githubInstallationId: installationId,
              githubInstallationToken: encryptToken(installationToken.token),
              githubInstallationTokenExpiresAt: new Date(installationToken.expires_at),
              githubAppKind: tier,
            }
          : {}),
      },
      update: {
        email,
        username: githubUser.login,
        avatarUrl: githubUser.avatar_url,
        accessToken: encryptToken(tokenResponse.access_token),
        ...(installationId && installationToken
          ? {
              githubInstallationId: installationId,
              githubInstallationToken: encryptToken(installationToken.token),
              githubInstallationTokenExpiresAt: new Date(installationToken.expires_at),
              githubAppKind: tier,
              accessTier: tier,
            }
          : {}),
      },
    })

    const token = app.jwt.sign({ sub: user.id, githubId: user.githubId })
    console.log('COOKIE DEBUG', { nodeEnv: process.env.NODE_ENV, frontendUrl: frontendUrl() })
    reply.setCookie('devpulse_token', token, {
      httpOnly: true,
      path: '/',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      secure: process.env.NODE_ENV === 'production',
    })

    const redirectUrl = new URL(frontendUrl())
    redirectUrl.searchParams.set('connected', tier)
    return reply.redirect(redirectUrl.toString())
  })

  app.get('/me', async (request, reply) => {
    const token = request.cookies.devpulse_token
    if (!token) {
      return reply.code(401).send({ error: 'Not authenticated' })
    }

    try {
      const payload = app.jwt.verify<{ sub: string }>(token)
      const user = await prisma.user.findUnique({
        where: { id: payload.sub },
        select: {
          id: true,
          githubId: true,
          username: true,
          giteaUsername: true,
          giteaBaseUrl: true,
          giteaToken: true,
          email: true,
          avatarUrl: true,
          accessToken: true,
          githubInstallationId: true,
          githubInstallationToken: true,
          githubInstallationTokenExpiresAt: true,
          accessTier: true,
        },
      })

      if (!user) {
        return reply.code(401).send({ error: 'User not found' })
      }

      return {
        user: {
          id: user.id,
          githubId: user.githubId,
          username: user.username,
          giteaUsername: user.giteaUsername,
          email: user.email,
          avatarUrl: user.avatarUrl,
          githubConnected: Boolean(user.githubInstallationId),
          githubAppInstalled: Boolean(user.githubInstallationId),
          accessTier: user.accessTier,
          giteaConnected: Boolean(user.giteaUsername && user.giteaBaseUrl && user.giteaToken),
          giteaBaseUrl: user.giteaBaseUrl,
        },
      }
    } catch {
      return reply.code(401).send({ error: 'Invalid session' })
    }
  })

  app.post('/unlink/github', async (request, reply) => {
    const token = request.cookies.devpulse_token
    if (!token) {
      return reply.code(401).send({ error: 'Not authenticated' })
    }

    try {
      const payload = app.jwt.verify<{ sub: string }>(token)

      const existingUser = await prisma.user.findUnique({
        where: { id: payload.sub },
        select: { githubInstallationId: true, accessTier: true },
      })

      await prisma.user.update({
        where: { id: payload.sub },
        data: {
          accessToken: '',
          githubInstallationId: null,
          githubInstallationToken: null,
          githubInstallationTokenExpiresAt: null,
        },
      })

      if (existingUser?.githubInstallationId) {
        try {
          const tier = (existingUser.accessTier ?? 'standard') as AccessTier
          await uninstallGitHubAppInstallation(existingUser.githubInstallationId, tier)
        } catch (error) {
          request.log.warn({ error }, 'Failed to uninstall GitHub App installation')
        }
      }

      return { provider: 'github', connected: false }
    } catch {
      return reply.code(401).send({ error: 'Invalid session' })
    }
  })

  app.post('/unlink/gitea', async (request, reply) => {
    const token = request.cookies.devpulse_token
    if (!token) {
      return reply.code(401).send({ error: 'Not authenticated' })
    }

    try {
      const payload = app.jwt.verify<{ sub: string }>(token)
      await prisma.user.update({
        where: { id: payload.sub },
        data: { giteaUsername: null, giteaBaseUrl: null, giteaToken: null },
      })

      return { provider: 'gitea', connected: false }
    } catch {
      return reply.code(401).send({ error: 'Invalid session' })
    }
  })

  app.get('/system', async (request, reply) => {
    const token = request.cookies.devpulse_token
    if (!token) {
      return reply.code(401).send({ error: 'Not authenticated' })
    }

    try {
      const payload = app.jwt.verify<{ sub: string }>(token)
      const [queueDepth, repoStates, recentFailures, user] = await Promise.all([
        getQueueDepth(),
        prisma.repo.findMany({
          where: { ownerId: payload.sub, isHidden: false },
          select: { syncStatus: true },
        }),
        prisma.repo.findMany({
          where: {
            ownerId: payload.sub,
            isHidden: false,
            syncStatus: 'failed',
            lastSyncError: { not: null },
          },
          select: { id: true, fullName: true, provider: true, lastSyncError: true, lastSyncFinishedAt: true },
          orderBy: { lastSyncFinishedAt: 'desc' },
          take: 5,
        }),
        prisma.user.findUnique({
          where: { id: payload.sub },
          select: { giteaBaseUrl: true, giteaToken: true },
        }),
      ])

      const statusCounts = repoStates.reduce<Record<string, number>>((counts, repo) => {
        counts[repo.syncStatus] = (counts[repo.syncStatus] ?? 0) + 1
        return counts
      }, {})

      return {
        api: {
          status: 'ok',
          nodeEnv: process.env.NODE_ENV ?? 'development',
          host: process.env.HOST ?? '127.0.0.1',
          port: Number(process.env.PORT ?? 3000),
        },
        sync: {
          intervalSeconds: Number(process.env.SYNC_INTERVAL_SECONDS ?? 86400),
          runOnStart: String(process.env.RUN_ON_START ?? 'true') === 'true',
          queueDepth,
          status: (statusCounts.failed ?? 0) > 0 ? 'degraded' : 'healthy',
          repos: {
            total: repoStates.length,
            queued: statusCounts.queued ?? 0,
            syncing: statusCounts.syncing ?? 0,
            healthy: statusCounts.healthy ?? 0,
            failed: statusCounts.failed ?? 0,
            idle: statusCounts.idle ?? 0,
          },
          recentFailures,
        },
        providers: {
          githubOauthConfigured: Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET),
          giteaConfigured: Boolean(user?.giteaBaseUrl && user?.giteaToken),
        },
      }
    } catch {
      return reply.code(401).send({ error: 'Invalid session' })
    }
  })

  app.post('/logout', async (_request, reply) => {
    reply.clearCookie('devpulse_token', { path: '/' })
    return { message: 'Logged out' }
  })
}