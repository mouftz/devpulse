import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import got from 'got'
import prisma from '../db.js'

type AuthPayload = {
  sub: string
  githubId: string
}

type GitHubRepo = {
  id: number
  full_name: string
  default_branch: string | null
  private: boolean
}

type GitHubCommit = {
  sha: string
  author: { login: string } | null
  commit: {
    message: string
    committer: { date: string }
  }
  stats?: {
    additions: number
    deletions: number
  }
}

type GitHubPullRequest = {
  number: number
  title: string
  state: string
  user: { login: string } | null
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

export async function repoRoutes(app: FastifyInstance) {
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
      select: { id: true, accessToken: true },
    })

    if (!user) {
      reply.code(401).send({ error: 'User not found' })
      return null
    }

    return user
  }

  const syncRepo = async (user: { id: string; accessToken: string }, repo: { id: string; fullName: string }) => {
    const headers = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${user.accessToken}`,
      'X-GitHub-Api-Version': '2022-11-28',
    }

    const commits = await got
      .get(`https://api.github.com/repos/${repo.fullName}/commits`, {
        searchParams: { per_page: '100' },
        headers,
      })
      .json<GitHubCommit[]>()

    const pullRequests = await got
      .get(`https://api.github.com/repos/${repo.fullName}/pulls`, {
        searchParams: { state: 'all', per_page: '100' },
        headers,
      })
      .json<GitHubPullRequest[]>()

    const synced = await prisma.$transaction(async (tx) => {
      const savedCommits = await Promise.all(
        commits.map((commit) =>
          tx.commit.upsert({
            where: { sha: commit.sha },
            create: {
              repoId: repo.id,
              sha: commit.sha,
              authorGithubId: commit.author?.login ?? 'ghost',
              message: commit.commit.message,
              additions: commit.stats?.additions ?? 0,
              deletions: commit.stats?.deletions ?? 0,
              committedAt: new Date(commit.commit.committer.date),
            },
            update: {
              authorGithubId: commit.author?.login ?? 'ghost',
              message: commit.commit.message,
              additions: commit.stats?.additions ?? 0,
              deletions: commit.stats?.deletions ?? 0,
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
              authorGithubId: pullRequest.user?.login ?? 'ghost',
              openedAt: new Date(pullRequest.created_at),
              mergedAt: pullRequest.merged_at ? new Date(pullRequest.merged_at) : null,
              closedAt: pullRequest.closed_at ? new Date(pullRequest.closed_at) : null,
            },
            update: {
              title: pullRequest.title,
              state: pullRequest.merged_at ? 'merged' : pullRequest.state,
              authorGithubId: pullRequest.user?.login ?? 'ghost',
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

    const githubRepos: GitHubRepo[] = []
    for await (const repo of got.paginate<GitHubRepo>('https://api.github.com/user/repos', {
        searchParams: {
          affiliation: 'owner,collaborator,organization_member',
          per_page: '100',
          sort: 'updated',
        },
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${user.accessToken}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      })) {
      githubRepos.push(repo)
    }

    const repos = await prisma.$transaction(
      githubRepos.map((repo) =>
        prisma.repo.upsert({
          where: { githubRepoId: String(repo.id) },
          create: {
            githubRepoId: String(repo.id),
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
      count: repos.length,
      repos: repos.map((repo) => ({
        id: repo.id,
        githubRepoId: repo.githubRepoId,
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
      where: { ownerId: user.id },
      select: { id: true, fullName: true },
      orderBy: { fullName: 'asc' },
    })

    const results = []
    for (const repo of repos) {
      try {
        const result = await syncRepo(user, repo)
        results.push({ status: 'synced', ...result })
      } catch (error) {
        results.push({
          status: 'failed',
          repo: {
            id: repo.id,
            fullName: repo.fullName,
          },
          error: error instanceof Error ? error.message : 'Unknown sync error',
        })
      }
    }

    const synced = results.filter((result) => result.status === 'synced')
    const failed = results.filter((result) => result.status === 'failed')

    return {
      total: results.length,
      synced: synced.length,
      failed: failed.length,
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
      },
    })

    if (!repo) {
      return reply.code(404).send({ error: 'Repo not found' })
    }

    return syncRepo(user, repo)
  })

  app.post<{
    Querystring: { fullName?: string }
  }>('/repos/sync', async (request, reply) => {
    const user = await authenticate(request, reply)
    if (!user) {
      return
    }

    if (!request.query.fullName) {
      return reply.code(400).send({ error: 'Missing fullName query parameter' })
    }

    const repo = await prisma.repo.findFirst({
      where: {
        fullName: request.query.fullName,
        ownerId: user.id,
      },
      select: { id: true, fullName: true },
    })

    if (!repo) {
      return reply.code(404).send({ error: 'Repo not found. Run GET /github/repos first.' })
    }

    return syncRepo(user, repo)
  })

  app.get<{ Params: { repoId: string } }>('/repos/:repoId/summary', async (request, reply) => {
    const user = await authenticate(request, reply)
    if (!user) {
      return
    }

    const repo = await prisma.repo.findFirst({
      where: {
        id: request.params.repoId,
        ownerId: user.id,
      },
      select: {
        id: true,
        fullName: true,
        lastSyncedAt: true,
      },
    })

    if (!repo) {
      return reply.code(404).send({ error: 'Repo not found' })
    }

    const [commitCount, pullRequestCount, mergedPullRequests] = await Promise.all([
      prisma.commit.count({ where: { repoId: repo.id } }),
      prisma.pullRequest.count({ where: { repoId: repo.id } }),
      prisma.pullRequest.findMany({
        where: {
          repoId: repo.id,
          mergedAt: { not: null },
        },
        select: {
          openedAt: true,
          mergedAt: true,
        },
      }),
    ])

    const cycleTimesHours = mergedPullRequests
      .filter((pullRequest) => pullRequest.mergedAt)
      .map((pullRequest) => {
        const openedAt = pullRequest.openedAt.getTime()
        const mergedAt = pullRequest.mergedAt?.getTime() ?? openedAt
        return (mergedAt - openedAt) / 1000 / 60 / 60
      })

    const averagePrCycleHours =
      cycleTimesHours.length > 0
        ? cycleTimesHours.reduce((total, hours) => total + hours, 0) / cycleTimesHours.length
        : null

    return {
      repo,
      metrics: {
        commits: commitCount,
        pullRequests: pullRequestCount,
        mergedPullRequests: mergedPullRequests.length,
        averagePrCycleHours,
      },
    }
  })

  app.get('/overview', async (request, reply) => {
    const user = await authenticate(request, reply)
    if (!user) {
      return
    }

    const repos = await prisma.repo.findMany({
      where: { ownerId: user.id },
      select: {
        id: true,
        fullName: true,
        lastSyncedAt: true,
        _count: {
          select: {
            commits: true,
            pullRequests: true,
          },
        },
      },
      orderBy: { lastSyncedAt: 'desc' },
    })

    const totals = repos.reduce(
      (summary, repo) => ({
        repos: summary.repos + 1,
        syncedRepos: summary.syncedRepos + (repo.lastSyncedAt ? 1 : 0),
        commits: summary.commits + repo._count.commits,
        pullRequests: summary.pullRequests + repo._count.pullRequests,
      }),
      { repos: 0, syncedRepos: 0, commits: 0, pullRequests: 0 },
    )

    return {
      totals,
      repos: repos.map((repo) => ({
        id: repo.id,
        fullName: repo.fullName,
        lastSyncedAt: repo.lastSyncedAt,
        commits: repo._count.commits,
        pullRequests: repo._count.pullRequests,
      })),
    }
  })

  app.get<{
    Querystring: { repoId?: string; days?: string }
  }>('/activity', async (request, reply) => {
    const user = await authenticate(request, reply)
    if (!user) {
      return
    }

    const dayCount = Math.min(Math.max(Number(request.query.days ?? 365), 1), 365)
    const end = new Date()
    const start = new Date(end)
    start.setUTCDate(start.getUTCDate() - (dayCount - 1))
    start.setUTCHours(0, 0, 0, 0)

    if (request.query.repoId) {
      const repo = await prisma.repo.findFirst({
        where: {
          id: request.query.repoId,
          ownerId: user.id,
        },
        select: { id: true },
      })

      if (!repo) {
        return reply.code(404).send({ error: 'Repo not found' })
      }
    }

    const commits = await prisma.commit.findMany({
      where: {
        repo: {
          ownerId: user.id,
          ...(request.query.repoId ? { id: request.query.repoId } : {}),
        },
        committedAt: { gte: start, lte: end },
      },
      select: { committedAt: true },
    })

    const counts = new Map<string, number>()
    for (let cursor = new Date(start); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
      counts.set(cursor.toISOString().slice(0, 10), 0)
    }

    for (const commit of commits) {
      const day = commit.committedAt.toISOString().slice(0, 10)
      counts.set(day, (counts.get(day) ?? 0) + 1)
    }

    return {
      total: commits.length,
      days: [...counts.entries()].map(([date, count]) => ({ date, count })),
    }
  })
}
