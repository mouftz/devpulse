import type { FastifyInstance } from 'fastify'
import got from 'got'
import prisma from '../db.js'
import { getQueueDepth } from '../lib/sync-queue.js'

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

const callbackUrl = () =>
  process.env.GITHUB_CALLBACK_URL ?? 'http://localhost:3000/auth/github/callback'

const frontendUrl = () => process.env.FRONTEND_URL ?? 'http://localhost:5173'

export async function authRoutes(app: FastifyInstance) {
  app.get('/github', async (_request, reply) => {
    const clientId = requiredEnv('GITHUB_CLIENT_ID')
    const state = crypto.randomUUID()
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: callbackUrl(),
      scope: 'read:user user:email repo',
      state,
    })

    return reply.redirect(`https://github.com/login/oauth/authorize?${params}`)
  })

  app.get<{
    Querystring: { code?: string; error?: string; error_description?: string }
  }>('/github/callback', async (request, reply) => {
    if (request.query.error) {
      return reply.code(400).send({
        error: request.query.error,
        message: request.query.error_description ?? 'GitHub OAuth failed',
      })
    }

    if (!request.query.code) {
      return reply.code(400).send({ error: 'Missing GitHub OAuth code' })
    }

    const tokenResponse = await got
      .post('https://github.com/login/oauth/access_token', {
        json: {
          client_id: requiredEnv('GITHUB_CLIENT_ID'),
          client_secret: requiredEnv('GITHUB_CLIENT_SECRET'),
          code: request.query.code,
          redirect_uri: callbackUrl(),
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

    const user = await prisma.user.upsert({
      where: { githubId: String(githubUser.id) },
      create: {
        githubId: String(githubUser.id),
        email,
        username: githubUser.login,
        avatarUrl: githubUser.avatar_url,
        accessToken: tokenResponse.access_token,
      },
      update: {
        email,
        username: githubUser.login,
        avatarUrl: githubUser.avatar_url,
        accessToken: tokenResponse.access_token,
      },
    })

    const token = app.jwt.sign({ sub: user.id, githubId: user.githubId })
    reply.setCookie('devpulse_token', token, {
      httpOnly: true,
      path: '/',
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
    })

    const redirectUrl = new URL(frontendUrl())
    redirectUrl.searchParams.set('connected', 'github')
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
          email: true,
          avatarUrl: true,
          accessToken: true,
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
          githubConnected: Boolean(user.accessToken),
          giteaConnected: Boolean(user.giteaUsername),
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
      await prisma.user.update({
        where: { id: payload.sub },
        data: { accessToken: '' },
      })

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
        data: { giteaUsername: null },
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
      const [queueDepth, repoStates, recentFailures] = await Promise.all([
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
          giteaConfigured: Boolean(process.env.GITEA_BASE_URL && process.env.GITEA_TOKEN),
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
