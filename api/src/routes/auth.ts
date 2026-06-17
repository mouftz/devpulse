import type { FastifyInstance } from 'fastify'
import got from 'got'
import prisma from '../db.js'

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

    return {
      message: 'GitHub connected',
      token,
      user: {
        id: user.id,
        githubId: user.githubId,
        username: user.username,
        email: user.email,
        avatarUrl: user.avatarUrl,
      },
    }
  })

  app.post('/logout', async (_request, reply) => {
    reply.clearCookie('devpulse_token', { path: '/' })
    return { message: 'Logged out' }
  })
}
