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

type GitHubReview = {
  id: number
  state: string
  submitted_at: string | null
  user: { login: string } | null
}

type AnalyticsScope = 'all' | 'mine'
type AnalyticsUser = {
  username: string
  giteaUsername: string | null
}

const getBearerToken = (request: FastifyRequest) => {
  const authorization = request.headers.authorization
  if (authorization?.startsWith('Bearer ')) {
    return authorization.slice('Bearer '.length)
  }

  return request.cookies.devpulse_token ?? null
}

const analyticsScope = (scope?: string): AnalyticsScope => (scope === 'all' ? 'all' : 'mine')

const analyticsAuthorIds = (user: AnalyticsUser) =>
  [...new Set([user.username, user.giteaUsername].filter((value): value is string => Boolean(value)))]

const authorFilter = (scope: AnalyticsScope, user: AnalyticsUser) =>
  scope === 'mine' ? { authorGithubId: { in: analyticsAuthorIds(user) } } : {}

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
      select: { id: true, username: true, giteaUsername: true, accessToken: true },
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

    const reviewsByPr = new Map<number, GitHubReview[]>()
    await Promise.all(
      pullRequests.map(async (pullRequest) => {
        try {
          const reviews = await got
            .get(`https://api.github.com/repos/${repo.fullName}/pulls/${pullRequest.number}/reviews`, { headers })
            .json<GitHubReview[]>()
          reviewsByPr.set(pullRequest.number, reviews)
        } catch {
          reviewsByPr.set(pullRequest.number, [])
        }
      }),
    )

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

      const savedReviews = await Promise.all(
        savedPullRequests.flatMap((savedPullRequest) => {
          const sourcePullRequest = pullRequests.find(
            (pullRequest) => pullRequest.number === savedPullRequest.githubPrNumber,
          )
          const reviews = reviewsByPr.get(savedPullRequest.githubPrNumber) ?? []

          if (!sourcePullRequest) return []

          return reviews
            .filter((review) => review.submitted_at)
            .map((review) => {
              const submittedAt = new Date(review.submitted_at ?? sourcePullRequest.created_at)
              const openedAt = new Date(sourcePullRequest.created_at)
              const timeToReviewMins = Math.max(
                0,
                Math.round((submittedAt.getTime() - openedAt.getTime()) / 1000 / 60),
              )

              return tx.prReview.upsert({
                where: { id: `github:${savedPullRequest.id}:${review.id}` },
                create: {
                  id: `github:${savedPullRequest.id}:${review.id}`,
                  prId: savedPullRequest.id,
                  reviewerGithubId: review.user?.login ?? 'ghost',
                  state: review.state.toLowerCase(),
                  timeToReviewMins,
                  submittedAt,
                },
                update: {
                  reviewerGithubId: review.user?.login ?? 'ghost',
                  state: review.state.toLowerCase(),
                  timeToReviewMins,
                  submittedAt,
                },
              })
            })
        }),
      )

      await tx.repo.update({
        where: { id: repo.id },
        data: { lastSyncedAt: new Date() },
      })

      return {
        commits: savedCommits.length,
        pullRequests: savedPullRequests.length,
        reviews: savedReviews.length,
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
      where: {
        ownerId: user.id,
        isHidden: false,
        githubRepoId: { not: { startsWith: 'gitea:' } },
      },
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
        isHidden: false,
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
        isHidden: false,
      },
      select: { id: true, fullName: true },
    })

    if (!repo) {
      return reply.code(404).send({ error: 'Repo not found. Run GET /github/repos first.' })
    }

    return syncRepo(user, repo)
  })

  app.delete<{ Params: { repoId: string } }>('/repos/:repoId', async (request, reply) => {
    const user = await authenticate(request, reply)
    if (!user) {
      return
    }

    const repo = await prisma.repo.findFirst({
      where: {
        id: request.params.repoId,
        ownerId: user.id,
        isHidden: false,
      },
      select: { id: true, fullName: true },
    })

    if (!repo) {
      return reply.code(404).send({ error: 'Repo not found' })
    }

    await prisma.repo.update({
      where: { id: repo.id },
      data: { isHidden: true },
    })

    return { repo, removed: true }
  })

  app.get<{ Params: { repoId: string }; Querystring: { scope?: string } }>('/repos/:repoId/summary', async (request, reply) => {
    const user = await authenticate(request, reply)
    if (!user) {
      return
    }
    const scope = analyticsScope(request.query.scope)

    const repo = await prisma.repo.findFirst({
      where: {
        id: request.params.repoId,
        ownerId: user.id,
        isHidden: false,
      },
      select: {
        id: true,
        githubRepoId: true,
        fullName: true,
        lastSyncedAt: true,
      },
    })

    if (!repo) {
      return reply.code(404).send({ error: 'Repo not found' })
    }

    const [commitCount, pullRequestCount, mergedPullRequests] = await Promise.all([
      prisma.commit.count({ where: { repoId: repo.id, ...authorFilter(scope, user) } }),
      prisma.pullRequest.count({ where: { repoId: repo.id, ...authorFilter(scope, user) } }),
      prisma.pullRequest.findMany({
        where: {
          repoId: repo.id,
          mergedAt: { not: null },
          ...authorFilter(scope, user),
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

  app.get<{
    Params: { repoId: string }
    Querystring: { days?: string; scope?: string }
  }>('/repos/:repoId/pr-cycle', async (request, reply) => {
    const user = await authenticate(request, reply)
    if (!user) {
      return
    }
    const scope = analyticsScope(request.query.scope)

    const dayCount = Math.min(Math.max(Number(request.query.days ?? 365), 7), 365)
    const end = new Date()
    const start = new Date(end)
    start.setUTCDate(start.getUTCDate() - (dayCount - 1))
    start.setUTCHours(0, 0, 0, 0)

    const repo = await prisma.repo.findFirst({
      where: {
        id: request.params.repoId,
        ownerId: user.id,
        isHidden: false,
      },
      select: { id: true },
    })

    if (!repo) {
      return reply.code(404).send({ error: 'Repo not found' })
    }

    const pullRequests = await prisma.pullRequest.findMany({
      where: {
        repoId: repo.id,
        mergedAt: { not: null, gte: start, lte: end },
        ...authorFilter(scope, user),
      },
      select: {
        openedAt: true,
        mergedAt: true,
      },
      orderBy: { openedAt: 'asc' },
    })

    const weeks = new Map<string, number[]>()
    for (const pullRequest of pullRequests) {
      if (!pullRequest.mergedAt) continue

      const weekStart = new Date(pullRequest.openedAt)
      weekStart.setUTCHours(0, 0, 0, 0)
      weekStart.setUTCDate(weekStart.getUTCDate() - weekStart.getUTCDay())
      const week = weekStart.toISOString().slice(0, 10)
      const cycleHours = (pullRequest.mergedAt.getTime() - pullRequest.openedAt.getTime()) / 1000 / 60 / 60
      weeks.set(week, [...(weeks.get(week) ?? []), cycleHours])
    }

    const weekly = [...weeks.entries()].map(([week, values]) => ({
      week,
      averageHours: values.reduce((total, value) => total + value, 0) / values.length,
      mergedPrs: values.length,
    }))

    const averageHours =
      pullRequests.length > 0
        ? weekly.reduce((total, week) => total + week.averageHours * week.mergedPrs, 0) / pullRequests.length
        : null

    const midpoint = Math.floor(weekly.length / 2)
    const earlier = weekly.slice(0, midpoint)
    const later = weekly.slice(midpoint)
    const average = (items: typeof weekly) =>
      items.length > 0 ? items.reduce((total, item) => total + item.averageHours, 0) / items.length : null
    const earlierAverage = average(earlier)
    const laterAverage = average(later)
    const deltaHours = earlierAverage != null && laterAverage != null ? laterAverage - earlierAverage : null
    const trend =
      deltaHours == null || Math.abs(deltaHours) < 4 ? 'steady' : deltaHours < 0 ? 'improving' : 'slowing'

    return {
      averageHours,
      trend,
      deltaHours,
      weeks: weekly,
    }
  })

  app.get<{
    Params: { repoId: string }
    Querystring: { days?: string; scope?: string }
  }>('/repos/:repoId/review-latency', async (request, reply) => {
    const user = await authenticate(request, reply)
    if (!user) {
      return
    }
    const scope = analyticsScope(request.query.scope)

    const dayCount = Math.min(Math.max(Number(request.query.days ?? 90), 7), 365)
    const end = new Date()
    const start = new Date(end)
    start.setUTCDate(start.getUTCDate() - (dayCount - 1))
    start.setUTCHours(0, 0, 0, 0)

    const repo = await prisma.repo.findFirst({
      where: {
        id: request.params.repoId,
        ownerId: user.id,
      },
      select: { id: true },
    })

    if (!repo) {
      return reply.code(404).send({ error: 'Repo not found' })
    }

    const pullRequests = await prisma.pullRequest.findMany({
      where: {
        repoId: repo.id,
        openedAt: { gte: start, lte: end },
        ...authorFilter(scope, user),
        reviews: { some: { timeToReviewMins: { not: null } } },
      },
      select: {
        id: true,
        openedAt: true,
        reviews: {
          where: { timeToReviewMins: { not: null } },
          select: {
            timeToReviewMins: true,
            submittedAt: true,
          },
          orderBy: { submittedAt: 'asc' },
          take: 1,
        },
      },
      orderBy: { openedAt: 'asc' },
    })

    const firstReviews = pullRequests
      .map((pullRequest) => ({
        openedAt: pullRequest.openedAt,
        timeToReviewMins: pullRequest.reviews[0]?.timeToReviewMins ?? null,
      }))
      .filter((review): review is { openedAt: Date; timeToReviewMins: number } => review.timeToReviewMins != null)

    const weeks = new Map<string, number[]>()
    for (const review of firstReviews) {
      const weekStart = new Date(review.openedAt)
      weekStart.setUTCHours(0, 0, 0, 0)
      weekStart.setUTCDate(weekStart.getUTCDate() - weekStart.getUTCDay())
      const week = weekStart.toISOString().slice(0, 10)
      weeks.set(week, [...(weeks.get(week) ?? []), review.timeToReviewMins / 60])
    }

    const weekly = [...weeks.entries()].map(([week, values]) => ({
      week,
      averageHours: values.reduce((total, value) => total + value, 0) / values.length,
      reviewedPrs: values.length,
    }))

    const averageHours =
      firstReviews.length > 0
        ? firstReviews.reduce((total, review) => total + review.timeToReviewMins / 60, 0) / firstReviews.length
        : null

    return {
      averageHours,
      reviewedPullRequests: firstReviews.length,
      weeks: weekly,
    }
  })

  app.get<{ Querystring: { scope?: string } }>('/overview', async (request, reply) => {
    const user = await authenticate(request, reply)
    if (!user) {
      return
    }
    const scope = analyticsScope(request.query.scope)

    const repos = await prisma.repo.findMany({
      where: { ownerId: user.id, isHidden: false },
      select: {
        id: true,
        githubRepoId: true,
        fullName: true,
        lastSyncedAt: true,
      },
      orderBy: { lastSyncedAt: 'desc' },
    })

    const reposWithCounts = await Promise.all(
      repos.map(async (repo) => {
        const [commits, pullRequests] = await Promise.all([
          prisma.commit.count({ where: { repoId: repo.id, ...authorFilter(scope, user) } }),
          prisma.pullRequest.count({ where: { repoId: repo.id, ...authorFilter(scope, user) } }),
        ])

        return { ...repo, commits, pullRequests }
      }),
    )

    const totals = reposWithCounts.reduce(
      (summary, repo) => ({
        repos: summary.repos + 1,
        syncedRepos: summary.syncedRepos + (repo.lastSyncedAt ? 1 : 0),
        commits: summary.commits + repo.commits,
        pullRequests: summary.pullRequests + repo.pullRequests,
      }),
      { repos: 0, syncedRepos: 0, commits: 0, pullRequests: 0 },
    )

    return {
      scope,
      totals,
      repos: reposWithCounts.map((repo) => ({
        id: repo.id,
        provider: repo.githubRepoId.startsWith('gitea:') ? 'gitea' : 'github',
        fullName: repo.fullName,
        lastSyncedAt: repo.lastSyncedAt,
        commits: repo.commits,
        pullRequests: repo.pullRequests,
      })),
    }
  })

  app.get<{ Querystring: { scope?: string } }>('/repos/manage', async (request, reply) => {
    const user = await authenticate(request, reply)
    if (!user) {
      return
    }
    const scope = analyticsScope(request.query.scope)

    const repos = await prisma.repo.findMany({
      where: { ownerId: user.id },
      select: {
        id: true,
        githubRepoId: true,
        fullName: true,
        isHidden: true,
        lastSyncedAt: true,
      },
      orderBy: [{ isHidden: 'asc' }, { fullName: 'asc' }],
    })

    const reposWithCounts = await Promise.all(
      repos.map(async (repo) => {
        const [commits, pullRequests] = await Promise.all([
          prisma.commit.count({ where: { repoId: repo.id, ...authorFilter(scope, user) } }),
          prisma.pullRequest.count({ where: { repoId: repo.id, ...authorFilter(scope, user) } }),
        ])

        return { ...repo, commits, pullRequests }
      }),
    )

    return {
      repos: reposWithCounts.map((repo) => ({
        id: repo.id,
        provider: repo.githubRepoId.startsWith('gitea:') ? 'gitea' : 'github',
        fullName: repo.fullName,
        isHidden: repo.isHidden,
        lastSyncedAt: repo.lastSyncedAt,
        commits: repo.commits,
        pullRequests: repo.pullRequests,
      })),
    }
  })

  const updateRepoVisibility = async (
    user: Awaited<ReturnType<typeof authenticate>>,
    repoId: string,
    isHidden: boolean,
    reply: FastifyReply,
  ) => {
    if (!user) {
      return
    }

    const repo = await prisma.repo.findFirst({
      where: {
        id: repoId,
        ownerId: user.id,
      },
      select: { id: true, fullName: true },
    })

    if (!repo) {
      return reply.code(404).send({ error: 'Repo not found' })
    }

    const updated = await prisma.repo.update({
      where: { id: repo.id },
      data: { isHidden },
      select: { id: true, fullName: true, isHidden: true },
    })

    return { repo: updated }
  }

  const visibilityHandler = async (
    request: FastifyRequest<{ Params: { repoId: string }; Body: { isHidden?: boolean } }>,
    reply: FastifyReply,
  ) => {
    const user = await authenticate(request, reply)
    if (!user) {
      return
    }

    if (typeof request.body.isHidden !== 'boolean') {
      return reply.code(400).send({ error: 'isHidden boolean is required' })
    }

    return updateRepoVisibility(user, request.params.repoId, request.body.isHidden, reply)
  }

  app.patch<{
    Params: { repoId: string }
    Body: { isHidden?: boolean }
  }>('/repos/:repoId/visibility', visibilityHandler)

  app.post<{
    Params: { repoId: string }
    Body: { isHidden?: boolean }
  }>('/repos/:repoId/visibility', visibilityHandler)

  app.get<{
    Querystring: { repoId?: string; days?: string; scope?: string }
  }>('/activity', async (request, reply) => {
    const user = await authenticate(request, reply)
    if (!user) {
      return
    }
    const scope = analyticsScope(request.query.scope)

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
          isHidden: false,
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
          isHidden: false,
          ...(request.query.repoId ? { id: request.query.repoId } : {}),
        },
        ...authorFilter(scope, user),
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
