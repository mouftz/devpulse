import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import got from 'got'
import prisma from '../db.js'

type AuthPayload = {
  sub: string
}

type GiteaRepo = {
  id: number
  full_name: string
  default_branch: string | null
  private: boolean
}

type GiteaCommit = {
  sha: string
  commit: {
    message: string
    committer: { date: string }
  }
  author?: { username?: string; login?: string } | null
}

type GiteaPullRequest = {
  number: number
  title: string
  state: string
  user?: { login?: string; username?: string } | null
  created_at: string
  merged_at: string | null
  closed_at: string | null
}

const getBearerToken = (request: FastifyRequest) => {
  const authorization = request.headers.authorization
  if (authorization?.startsWith('Bearer ')) {
    return authorization.slice('Bearer '.length)
  }

  return request.cookies.devpulse_token ?? null
}

const giteaApiUrl = () => {
  const baseUrl = process.env.GITEA_BASE_URL
  if (!baseUrl) {
    throw new Error('GITEA_BASE_URL is required')
  }

  return `${baseUrl.replace(/\/$/, '')}/api/v1`
}

const giteaHeaders = () => {
  if (!process.env.GITEA_TOKEN) {
    throw new Error('GITEA_TOKEN is required')
  }

  return {
    Accept: 'application/json',
    Authorization: `token ${process.env.GITEA_TOKEN}`,
  }
}

const providerRepoId = (id: number) => `gitea:${id}`
const providerCommitSha = (repoId: string, sha: string) => `gitea:${repoId}:${sha}`

export async function giteaRoutes(app: FastifyInstance) {
  const authenticate = async (request: FastifyRequest, reply: FastifyReply) => {
    const token = getBearerToken(request)
    if (!token) {
      reply.code(401).send({ error: 'Missing bearer token' })
      return null
    }

    let payload: AuthPayload
    try {
      payload = app.jwt.verify<AuthPayload>(token)
    } catch {
      reply.code(401).send({ error: 'Invalid bearer token' })
      return null
    }

    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true },
    })

    if (!user) {
      reply.code(401).send({ error: 'User not found' })
      return null
    }

    return user
  }

  const syncRepo = async (repo: { id: string; fullName: string }) => {
    const [owner, name] = repo.fullName.split('/')
    if (!owner || !name) {
      throw new Error(`Invalid Gitea repo name: ${repo.fullName}`)
    }

    const apiUrl = giteaApiUrl()
    const headers = giteaHeaders()

    const commits = await got
      .get(`${apiUrl}/repos/${owner}/${name}/commits`, {
        searchParams: { limit: '100' },
        headers,
      })
      .json<GiteaCommit[]>()

    const pullRequests = await got
      .get(`${apiUrl}/repos/${owner}/${name}/pulls`, {
        searchParams: { state: 'all', limit: '100' },
        headers,
      })
      .json<GiteaPullRequest[]>()

    const synced = await prisma.$transaction(async (tx) => {
      const savedCommits = await Promise.all(
        commits.map((commit) =>
          tx.commit.upsert({
            where: { sha: providerCommitSha(repo.id, commit.sha) },
            create: {
              repoId: repo.id,
              sha: providerCommitSha(repo.id, commit.sha),
              authorGithubId: commit.author?.login ?? commit.author?.username ?? 'ghost',
              message: commit.commit.message,
              committedAt: new Date(commit.commit.committer.date),
            },
            update: {
              authorGithubId: commit.author?.login ?? commit.author?.username ?? 'ghost',
              message: commit.commit.message,
              committedAt: new Date(commit.commit.committer.date),
            },
          }),
        ),
      )

      const savedPullRequests = await Promise.all(
        pullRequests.map((pullRequest) =>
          tx.pullRequest.upsert({
            where: {
              repoId_githubPrNumber: {
                repoId: repo.id,
                githubPrNumber: pullRequest.number,
              },
            },
            create: {
              repoId: repo.id,
              githubPrNumber: pullRequest.number,
              title: pullRequest.title,
              state: pullRequest.merged_at ? 'merged' : pullRequest.state,
              authorGithubId: pullRequest.user?.login ?? pullRequest.user?.username ?? 'ghost',
              openedAt: new Date(pullRequest.created_at),
              mergedAt: pullRequest.merged_at ? new Date(pullRequest.merged_at) : null,
              closedAt: pullRequest.closed_at ? new Date(pullRequest.closed_at) : null,
            },
            update: {
              title: pullRequest.title,
              state: pullRequest.merged_at ? 'merged' : pullRequest.state,
              authorGithubId: pullRequest.user?.login ?? pullRequest.user?.username ?? 'ghost',
              openedAt: new Date(pullRequest.created_at),
              mergedAt: pullRequest.merged_at ? new Date(pullRequest.merged_at) : null,
              closedAt: pullRequest.closed_at ? new Date(pullRequest.closed_at) : null,
            },
          }),
        ),
      )

      await tx.repo.update({
        where: { id: repo.id },
        data: { lastSyncedAt: new Date() },
      })

      return {
        commits: savedCommits.length,
        pullRequests: savedPullRequests.length,
      }
    })

    return {
      repo: {
        id: repo.id,
        fullName: repo.fullName,
      },
      synced,
    }
  }

  app.get('/repos', async (request, reply) => {
    const user = await authenticate(request, reply)
    if (!user) {
      return
    }

    const repos = await got
      .get(`${giteaApiUrl()}/user/repos`, {
        searchParams: { limit: '100' },
        headers: giteaHeaders(),
      })
      .json<GiteaRepo[]>()

    const savedRepos = await prisma.$transaction(
      repos.map((repo) =>
        prisma.repo.upsert({
          where: { githubRepoId: providerRepoId(repo.id) },
          create: {
            githubRepoId: providerRepoId(repo.id),
            ownerId: user.id,
            fullName: repo.full_name,
            defaultBranch: repo.default_branch ?? 'main',
            isPrivate: repo.private,
          },
          update: {
            fullName: repo.full_name,
            defaultBranch: repo.default_branch ?? 'main',
            isPrivate: repo.private,
          },
        }),
      ),
    )

    return {
      count: savedRepos.length,
      repos: savedRepos.map((repo) => ({
        id: repo.id,
        provider: 'gitea',
        fullName: repo.fullName,
        defaultBranch: repo.defaultBranch,
        isPrivate: repo.isPrivate,
        lastSyncedAt: repo.lastSyncedAt,
      })),
    }
  })

  const syncAllRepos = async (request: FastifyRequest, reply: FastifyReply) => {
    const user = await authenticate(request, reply)
    if (!user) {
      return
    }

    const repos = await prisma.repo.findMany({
      where: {
        ownerId: user.id,
        githubRepoId: { startsWith: 'gitea:' },
      },
      select: { id: true, fullName: true },
      orderBy: { fullName: 'asc' },
    })

    const results = []
    for (const repo of repos) {
      try {
        const result = await syncRepo(repo)
        results.push({ status: 'synced', ...result })
      } catch (error) {
        results.push({
          status: 'failed',
          repo,
          error: error instanceof Error ? error.message : 'Unknown sync error',
        })
      }
    }

    return {
      total: results.length,
      synced: results.filter((result) => result.status === 'synced').length,
      failed: results.filter((result) => result.status === 'failed').length,
      results,
    }
  }

  app.get('/repos/sync-all', syncAllRepos)
  app.post('/repos/sync-all', syncAllRepos)

  app.post<{ Params: { repoId: string } }>('/repos/:repoId/sync', async (request, reply) => {
    const user = await authenticate(request, reply)
    if (!user) {
      return
    }

    const repo = await prisma.repo.findFirst({
      where: {
        id: request.params.repoId,
        ownerId: user.id,
        githubRepoId: { startsWith: 'gitea:' },
      },
      select: { id: true, fullName: true },
    })

    if (!repo) {
      return reply.code(404).send({ error: 'Gitea repo not found' })
    }

    return syncRepo(repo)
  })
}
