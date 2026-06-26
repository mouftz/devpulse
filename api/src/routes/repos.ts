import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import got from 'got'
import prisma from '../db.js'
import { legacyRepoKey } from '../lib/provider-helpers.js'
import {
  enqueueRepos,
  enqueueRepoSync,
  getQueueDepth,
  markRepoSyncFailed,
  markRepoSyncStarted,
  markRepoSyncSucceeded,
} from '../lib/sync-queue.js'
import { normalizeSyncError } from '../lib/sync-errors.js'
import { mapWithConcurrency } from '../lib/concurrency.js'
import { predictRepoCycleTimes } from '../lib/ml-client.js'
import { getGitHubAccessTokenForUser } from '../lib/github-app.js'
import type { Response } from 'got'

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

type GitHubInstallationRepositoriesResponse = {
  repositories: GitHubRepo[]
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

type GitHubReviewComment = {
  id: number
  body: string
  created_at: string
  user: { login: string } | null
}

type GitHubIssueComment = {
  id: number
  body: string
  created_at: string
  user: { login: string } | null
}

type AnalyticsScope = 'all' | 'mine'
type ActionableInsight = {
  id: string
  severity: 'critical' | 'warning' | 'opportunity' | 'positive'
  title: string
  detail: string
  actionLabel: string
  actionKind: 'sync' | 'inspect' | 'none'
  repoId?: string
  repoFullName?: string
  impact: 'high' | 'medium' | 'low'
  evidence: string
  metric?: {
    key: string
    label: string
    value: number
    better: 'higher' | 'lower'
  }
}
type AnalyticsUser = {
  username: string
  giteaUsername: string | null
}

const analyticsWindow = (value: string | undefined, fallback: number, minimum: number) => {
  if (value === 'all') return { dayCount: 0, start: null }
  const dayCount = Math.min(Math.max(Number(value ?? fallback), minimum), 365)
  const start = new Date()
  start.setUTCDate(start.getUTCDate() - (dayCount - 1))
  start.setUTCHours(0, 0, 0, 0)
  return { dayCount, start }
}

const PROVIDER_REQUEST_CONCURRENCY = Math.max(1, Math.min(20, Number(process.env.PROVIDER_REQUEST_CONCURRENCY ?? 5)))

export type GitHubSyncUser = {
  id: string
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

const githubHeaders = (accessToken: string) => ({
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${accessToken}`,
  'X-GitHub-Api-Version': '2022-11-28',
})

const paginateGitHub = async <T>(url: string, accessToken: string, searchParams?: Record<string, string>) => {
  const results: T[] = []
  for await (const item of got.paginate<T>(url, {
    searchParams: {
      per_page: '100',
      ...(searchParams ?? {}),
    },
    headers: githubHeaders(accessToken),
    pagination: {
      transform: (response) => JSON.parse(String(response.body)) as T[],
      paginate: ({ response }) => {
        const linkHeader = Array.isArray(response.headers.link)
          ? response.headers.link.join(',')
          : response.headers.link ?? ''
        const next = linkHeader
          .split(',')
          .map((part: string) => part.trim())
          .find((part: string) => part.includes('rel="next"'))
          ?.match(/<([^>]+)>/)?.[1]
        return next ? { url: next } : false
      },
    },
  })) {
    results.push(item)
  }
  return results
}

export const syncGitHubRepo = async (
  user: GitHubSyncUser,
  repo: { id: string; fullName: string },
) => {
  await markRepoSyncStarted(repo.id)

  try {
    const accessToken = await getGitHubAccessTokenForUser(user.id)
    const commits = await paginateGitHub<GitHubCommit>(
      `https://api.github.com/repos/${repo.fullName}/commits`,
      accessToken,
    )
    const pullRequests = await paginateGitHub<GitHubPullRequest>(
      `https://api.github.com/repos/${repo.fullName}/pulls`,
      accessToken,
      { state: 'all' },
    )
    const reviewsByPr = new Map<number, GitHubReview[]>()
    const reviewCommentsByPr = new Map<number, GitHubReviewComment[]>()
    const issueCommentsByPr = new Map<number, GitHubIssueComment[]>()

    await mapWithConcurrency(
      pullRequests,
      PROVIDER_REQUEST_CONCURRENCY,
      async (pullRequest) => {
        try {
          const [reviews, reviewComments, issueComments] = await Promise.all([
            paginateGitHub<GitHubReview>(
              `https://api.github.com/repos/${repo.fullName}/pulls/${pullRequest.number}/reviews`,
              accessToken,
            ),
            paginateGitHub<GitHubReviewComment>(
              `https://api.github.com/repos/${repo.fullName}/pulls/${pullRequest.number}/comments`,
              accessToken,
            ),
            paginateGitHub<GitHubIssueComment>(
              `https://api.github.com/repos/${repo.fullName}/issues/${pullRequest.number}/comments`,
              accessToken,
            ),
          ])
          reviewsByPr.set(pullRequest.number, reviews)
          reviewCommentsByPr.set(pullRequest.number, reviewComments)
          issueCommentsByPr.set(pullRequest.number, issueComments)
        } catch {
          reviewsByPr.set(pullRequest.number, [])
          reviewCommentsByPr.set(pullRequest.number, [])
          issueCommentsByPr.set(pullRequest.number, [])
        }
      },
    )

    const synced = await prisma.$transaction(async (tx) => {
      const savedCommits = await Promise.all(
        commits.map((commit) =>
          tx.commit.upsert({
            where: { repoId_sha: { repoId: repo.id, sha: commit.sha } },
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

      const savedComments = await Promise.all(
        savedPullRequests.flatMap((savedPullRequest) => {
          const reviewComments = reviewCommentsByPr.get(savedPullRequest.githubPrNumber) ?? []
          const issueComments = issueCommentsByPr.get(savedPullRequest.githubPrNumber) ?? []

          return [...reviewComments, ...issueComments].map((comment) => {
            const isReviewComment = reviewComments.some((entry) => entry.id === comment.id)
            return tx.prComment.upsert({
              where: {
                id: `github:${savedPullRequest.id}:${isReviewComment ? 'review' : 'issue'}:${comment.id}`,
              },
              create: {
                id: `github:${savedPullRequest.id}:${isReviewComment ? 'review' : 'issue'}:${comment.id}`,
                prId: savedPullRequest.id,
                commenterGithubId: comment.user?.login ?? 'ghost',
                kind: isReviewComment ? 'review' : 'issue',
                body: comment.body.slice(0, 4000),
                commentedAt: new Date(comment.created_at),
              },
              update: {
                commenterGithubId: comment.user?.login ?? 'ghost',
                kind: isReviewComment ? 'review' : 'issue',
                body: comment.body.slice(0, 4000),
                commentedAt: new Date(comment.created_at),
              },
            })
          })
        }),
      )

      return {
        commits: savedCommits.length,
        pullRequests: savedPullRequests.length,
        reviews: savedReviews.length,
        comments: savedComments.length,
      }
    })

    await markRepoSyncSucceeded(repo.id)
    const prediction = await predictRepoCycleTimes(repo.id)

    return {
      repo: {
        id: repo.id,
        fullName: repo.fullName,
      },
      synced,
      prediction,
    }
  } catch (error) {
    await markRepoSyncFailed(repo.id, normalizeSyncError(error))
    throw error
  }
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
      select: {
        id: true,
        username: true,
        giteaUsername: true,
        githubInstallationId: true,
        githubInstallationToken: true,
        accessTier: true,
        githubAppKind: true,
      },
    })

    if (!user) {
      reply.code(401).send({ error: 'User not found' })
      return null
    }

    return user
  }

  app.get('/repos', async (request, reply) => {
    const user = await authenticate(request, reply)
    if (!user) {
      return
    }

    const githubRepos: GitHubRepo[] = []
    const githubAppKind = user.githubAppKind === 'standard' || user.githubAppKind === 'full'
      ? user.githubAppKind
      : user.accessTier
    const requiresInstallationRepos = githubAppKind === 'full'
    const useInstallationRepos = Boolean(user.githubInstallationId || user.githubInstallationToken)
    const accessToken = await getGitHubAccessTokenForUser(user.id)
    const repoUrl = useInstallationRepos ? 'https://api.github.com/installation/repositories' : 'https://api.github.com/user/repos'
    const repoSearchParams = useInstallationRepos
      ? { per_page: '100' }
      : { affiliation: 'owner,collaborator,organization_member', per_page: '100', sort: 'updated' }


    const paginationOptions = useInstallationRepos
      ? {
          pagination: {
            transform: (response: Response<unknown>) =>
              (JSON.parse(String(response.body)) as GitHubInstallationRepositoriesResponse).repositories,
            paginate: ({ response }: { response: Response<unknown> }) => {
              const linkHeader = Array.isArray(response.headers.link)
                ? response.headers.link.join(',')
                : response.headers.link ?? ''

              const next = linkHeader
                .split(',')
                .map((part: string) => part.trim())
                .find((part: string) => part.includes('rel="next"'))
                ?.match(/<([^>]+)>/)?.[1]

              return next ? { url: next } : false
            },
          },
        }
      : {}

    try {
      for await (const repo of got.paginate<GitHubRepo>(repoUrl, {
        searchParams: repoSearchParams,
        headers: githubHeaders(accessToken),
        ...paginationOptions,
      })) {
        githubRepos.push(repo)
      }
    } catch (error) {
      if (!useInstallationRepos || requiresInstallationRepos) throw error

      request.log.warn({ error }, 'GitHub installation repository listing failed; retrying OAuth repository listing')
      for await (const repo of got.paginate<GitHubRepo>('https://api.github.com/user/repos', {
        searchParams: { affiliation: 'owner,collaborator,organization_member', per_page: '100', sort: 'updated' },
        headers: githubHeaders(accessToken),
      })) {
        githubRepos.push(repo)
      }
    }

    const repos = await prisma.$transaction(
      githubRepos.map((repo) =>
        prisma.repo.upsert({
          where: {
            ownerId_provider_providerRepoId: {
              ownerId: user.id,
              provider: 'github',
              providerRepoId: String(repo.id),
            },
          },
          create: {
            githubRepoId: legacyRepoKey('github', String(repo.id)),
            provider: 'github',
            providerRepoId: String(repo.id),
            ownerId: user.id,
            fullName: repo.full_name,
            defaultBranch: repo.default_branch ?? 'main',
            isPrivate: repo.private,
          },
          update: {
            githubRepoId: legacyRepoKey('github', String(repo.id)),
            provider: 'github',
            providerRepoId: String(repo.id),
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
        provider: repo.provider,
        providerRepoId: repo.providerRepoId,
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
        provider: 'github',
      },
      select: { id: true, fullName: true },
      orderBy: { fullName: 'asc' },
    })

    const results = []
    for (const repo of repos) {
      try {
        const result = await syncGitHubRepo(user, repo)
        results.push({ status: 'synced', ...result })
      } catch (error) {
        results.push({
          status: 'failed',
          repo: {
            id: repo.id,
            fullName: repo.fullName,
          },
          error: normalizeSyncError(error),
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

    return syncGitHubRepo(user, repo)
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
      return reply.code(404).send({ error: 'Repo not found. Refresh repositories first.' })
    }

    return syncGitHubRepo(user, repo)
  })

  app.post('/repos/sync-all/background', async (request, reply) => {
    const user = await authenticate(request, reply)
    if (!user) {
      return
    }

    const repos = await prisma.repo.findMany({
      where: {
        ownerId: user.id,
        isHidden: false,
        provider: 'github',
      },
      select: { id: true, provider: true, providerRepoId: true, githubRepoId: true, ownerId: true },
      orderBy: { fullName: 'asc' },
    })

    await enqueueRepos(repos, 'manual')
    return { queued: repos.length, queueDepth: await getQueueDepth() }
  })

  app.post<{ Params: { repoId: string } }>('/repos/:repoId/sync/background', async (request, reply) => {
    const user = await authenticate(request, reply)
    if (!user) {
      return
    }

    const repo = await prisma.repo.findFirst({
      where: {
        id: request.params.repoId,
        ownerId: user.id,
        isHidden: false,
        provider: 'github',
      },
      select: { id: true, provider: true, providerRepoId: true, githubRepoId: true, ownerId: true },
    })

    if (!repo) {
      return reply.code(404).send({ error: 'Repo not found' })
    }

    await enqueueRepoSync(repo, 'manual')
    return { queued: 1, queueDepth: await getQueueDepth() }
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

  app.get<{ Params: { repoId: string }; Querystring: { days?: string; scope?: string } }>('/repos/:repoId/summary', async (request, reply) => {
    const user = await authenticate(request, reply)
    if (!user) {
      return
    }
    const scope = analyticsScope(request.query.scope)
    const { start } = analyticsWindow(request.query.days, 365, 7)

    const repo = await prisma.repo.findFirst({
      where: {
        id: request.params.repoId,
        ownerId: user.id,
        isHidden: false,
      },
      select: {
        id: true,
        provider: true,
        providerRepoId: true,
        githubRepoId: true,
        fullName: true,
        lastSyncedAt: true,
        syncStatus: true,
        lastSyncError: true,
        lastSyncStartedAt: true,
        lastSyncFinishedAt: true,
      },
    })

    if (!repo) {
      return reply.code(404).send({ error: 'Repo not found' })
    }

    const [commitCount, pullRequestCount, mergedPullRequests] = await Promise.all([
      prisma.commit.count({
        where: {
          repoId: repo.id,
          ...(start ? { committedAt: { gte: start } } : {}),
          ...authorFilter(scope, user),
        },
      }),
      prisma.pullRequest.count({
        where: {
          repoId: repo.id,
          ...(start ? { openedAt: { gte: start } } : {}),
          ...authorFilter(scope, user),
        },
      }),
      prisma.pullRequest.findMany({
        where: {
          repoId: repo.id,
          mergedAt: { not: null, ...(start ? { gte: start } : {}) },
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

    const { dayCount, start } = analyticsWindow(request.query.days, 365, 7)
    const end = new Date()

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
        mergedAt: { not: null, ...(start ? { gte: start } : {}), lte: end },
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

      // The range is based on merge time, so bucket and label points by merge time too.
      const weekStart = new Date(pullRequest.mergedAt)
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

    const { start } = analyticsWindow(request.query.days, 90, 7)
    const end = new Date()

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
        openedAt: { ...(start ? { gte: start } : {}), lte: end },
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

  app.get<{ Params: { repoId: string } }>('/repos/:repoId/predictions', async (request, reply) => {
    const user = await authenticate(request, reply)
    if (!user) return

    const repo = await prisma.repo.findFirst({
      where: { id: request.params.repoId, ownerId: user.id, isHidden: false },
      select: { id: true },
    })
    if (!repo) return reply.code(404).send({ error: 'Repo not found' })

    const openPullRequests = await prisma.pullRequest.findMany({
      where: { repoId: repo.id, state: 'open', mergedAt: null },
      select: {
        id: true,
        githubPrNumber: true,
        title: true,
        openedAt: true,
        predictions: {
          orderBy: { predictedAt: 'desc' },
          take: 1,
          select: {
            predictedHours: true,
            lowerBoundHours: true,
            upperBoundHours: true,
            modelVersion: true,
            modelKind: true,
            predictedAt: true,
          },
        },
      },
      orderBy: { openedAt: 'desc' },
    })

    return {
      predictions: openPullRequests
        .filter((pullRequest) => pullRequest.predictions.length > 0)
        .map((pullRequest) => ({
          pullRequest: {
            number: pullRequest.githubPrNumber,
            title: pullRequest.title,
            openedAt: pullRequest.openedAt,
          },
          ...pullRequest.predictions[0],
        })),
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
        provider: true,
        providerRepoId: true,
        githubRepoId: true,
        fullName: true,
        lastSyncedAt: true,
        syncStatus: true,
        lastSyncError: true,
        lastSyncStartedAt: true,
        lastSyncFinishedAt: true,
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
        provider: repo.provider as 'github' | 'gitea',
        fullName: repo.fullName,
        lastSyncedAt: repo.lastSyncedAt,
        syncStatus: repo.syncStatus,
        lastSyncError: repo.lastSyncError,
        lastSyncStartedAt: repo.lastSyncStartedAt,
        lastSyncFinishedAt: repo.lastSyncFinishedAt,
        commits: repo.commits,
        pullRequests: repo.pullRequests,
      })),
    }
  })

  app.get<{ Querystring: { days?: string; scope?: string } }>('/insights', async (request, reply) => {
    const user = await authenticate(request, reply)
    if (!user) {
      return
    }
    const scope = analyticsScope(request.query.scope)
    const { dayCount, start } = analyticsWindow(request.query.days, 90, 1)
    const end = new Date()

    const visibleRepos = await prisma.repo.findMany({
      where: { ownerId: user.id, isHidden: false },
      select: {
        id: true,
        fullName: true,
        lastSyncedAt: true,
        syncStatus: true,
        lastSyncError: true,
      },
    })

    const [commits, mergedPullRequests, reviewedPullRequests] = await Promise.all([
      prisma.commit.findMany({
        where: {
          repo: { ownerId: user.id, isHidden: false },
          ...authorFilter(scope, user),
          committedAt: { ...(start ? { gte: start } : {}), lte: end },
        },
        select: { repoId: true },
      }),
      prisma.pullRequest.findMany({
        where: {
          repo: { ownerId: user.id, isHidden: false },
          ...authorFilter(scope, user),
          mergedAt: { not: null, ...(start ? { gte: start } : {}), lte: end },
        },
        select: { repoId: true, openedAt: true, mergedAt: true },
      }),
      prisma.pullRequest.findMany({
        where: {
          repo: { ownerId: user.id, isHidden: false },
          ...authorFilter(scope, user),
          openedAt: { ...(start ? { gte: start } : {}), lte: end },
          reviews: { some: { timeToReviewMins: { not: null } } },
        },
        select: {
          repoId: true,
          reviews: {
            where: { timeToReviewMins: { not: null } },
            orderBy: { submittedAt: 'asc' },
            select: { timeToReviewMins: true },
          },
        },
      }),
    ])

    const activeRepos = new Set(commits.map((commit) => commit.repoId)).size
    const averagePrCycleHours =
      mergedPullRequests.length > 0
        ? mergedPullRequests.reduce((total, pullRequest) => {
            const opened = pullRequest.openedAt.getTime()
            const merged = pullRequest.mergedAt?.getTime() ?? opened
            return total + (merged - opened) / 1000 / 60 / 60
          }, 0) / mergedPullRequests.length
        : null

    const firstReviewHours = reviewedPullRequests
      .map((pullRequest) => pullRequest.reviews[0]?.timeToReviewMins ?? null)
      .filter((value): value is number => value != null)
      .map((value) => value / 60)

    const averageReviewLatencyHours =
      firstReviewHours.length > 0
        ? firstReviewHours.reduce((total, value) => total + value, 0) / firstReviewHours.length
        : null

    const staleRepos = visibleRepos.filter((repo) => {
      if (!repo.lastSyncedAt) return true
      const ageMs = end.getTime() - repo.lastSyncedAt.getTime()
      return ageMs > 1000 * 60 * 60 * 24 * 7
    }).length

    const recommendations: ActionableInsight[] = []
    const repoNames = new Map(visibleRepos.map((repo) => [repo.id, repo.fullName]))
    const failedRepo = visibleRepos.find((repo) => repo.syncStatus === 'failed')
    if (failedRepo) {
      recommendations.push({
        id: `failed-sync-${failedRepo.id}`,
        severity: 'critical',
        title: `Repair ${failedRepo.fullName ?? 'repository'} sync`,
        detail: failedRepo.lastSyncError ?? 'The latest sync failed, so its analytics may be incomplete.',
        actionLabel: 'Retry sync',
        actionKind: 'sync',
        repoId: failedRepo.id,
        repoFullName: failedRepo.fullName,
        impact: 'high',
        evidence: 'The latest repository sync ended in a failed state.',
      })
    }

    const staleRepo = visibleRepos.find((repo) => {
      if (repo.syncStatus === 'failed') return false
      if (!repo.lastSyncedAt) return true
      return end.getTime() - repo.lastSyncedAt.getTime() > 1000 * 60 * 60 * 24 * 7
    })
    if (staleRepo) {
      recommendations.push({
        id: `stale-repo-${staleRepo.id}`,
        severity: 'warning',
        title: `Refresh ${staleRepo.fullName ?? 'stale repository'}`,
        detail: staleRepo.lastSyncedAt
          ? 'Its analytics are more than seven days old.'
          : 'This repository has not completed its first sync yet.',
        actionLabel: 'Sync now',
        actionKind: 'sync',
        repoId: staleRepo.id,
        repoFullName: staleRepo.fullName,
        impact: staleRepo.lastSyncedAt ? 'medium' : 'high',
        evidence: staleRepo.lastSyncedAt
          ? `Last successful sync was ${Math.floor((end.getTime() - staleRepo.lastSyncedAt.getTime()) / 86_400_000)} days ago.`
          : 'No successful sync has been recorded.',
      })
    }

    const reviewHoursByRepo = reviewedPullRequests.reduce((groups, pullRequest) => {
      const hours = (pullRequest.reviews[0]?.timeToReviewMins ?? 0) / 60
      if (!pullRequest.repoId || hours <= 0) return groups
      const current = groups.get(pullRequest.repoId) ?? { total: 0, count: 0 }
      groups.set(pullRequest.repoId, { total: current.total + hours, count: current.count + 1 })
      return groups
    }, new Map<string, { total: number; count: number }>())
    const slowestReviewRepo = [...reviewHoursByRepo.entries()]
      .map(([repoId, values]) => ({ repoId, average: values.total / values.count }))
      .sort((a, b) => b.average - a.average)[0]

    if (slowestReviewRepo && slowestReviewRepo.average > 24) {
      recommendations.push({
        id: `slow-first-review-${slowestReviewRepo.repoId}`,
        severity: 'warning',
        title: 'Reduce time to first review',
        detail: `Pull requests wait ${slowestReviewRepo.average.toFixed(1)} hours on average for their first review.`,
        actionLabel: 'Inspect repository',
        actionKind: 'inspect',
        repoId: slowestReviewRepo.repoId,
        ...(repoNames.get(slowestReviewRepo.repoId)
          ? { repoFullName: repoNames.get(slowestReviewRepo.repoId)! }
          : {}),
        impact: slowestReviewRepo.average > 48 ? 'high' : 'medium',
        evidence: `${reviewHoursByRepo.get(slowestReviewRepo.repoId)?.count ?? 0} reviewed pull requests in this timeframe.`,
        metric: {
          key: `review-latency-${slowestReviewRepo.repoId}`,
          label: 'First-review latency',
          value: slowestReviewRepo.average,
          better: 'lower',
        },
      })
    }

    const cycleHoursByRepo = mergedPullRequests.reduce((groups, pullRequest) => {
      if (!pullRequest.repoId || !pullRequest.mergedAt) return groups
      const hours = (pullRequest.mergedAt.getTime() - pullRequest.openedAt.getTime()) / 1000 / 60 / 60
      const current = groups.get(pullRequest.repoId) ?? { total: 0, count: 0 }
      groups.set(pullRequest.repoId, { total: current.total + hours, count: current.count + 1 })
      return groups
    }, new Map<string, { total: number; count: number }>())
    const slowestCycleRepo = [...cycleHoursByRepo.entries()]
      .map(([repoId, values]) => ({ repoId, average: values.total / values.count }))
      .sort((a, b) => b.average - a.average)[0]

    if (slowestCycleRepo && slowestCycleRepo.average > 72) {
      recommendations.push({
        id: `slow-pr-cycle-${slowestCycleRepo.repoId}`,
        severity: 'opportunity',
        title: 'Break down long-running pull requests',
        detail: `Merged pull requests take ${slowestCycleRepo.average.toFixed(1)} hours on average. Smaller changes may move faster.`,
        actionLabel: 'Inspect repository',
        actionKind: 'inspect',
        repoId: slowestCycleRepo.repoId,
        ...(repoNames.get(slowestCycleRepo.repoId)
          ? { repoFullName: repoNames.get(slowestCycleRepo.repoId)! }
          : {}),
        impact: slowestCycleRepo.average > 168 ? 'high' : 'medium',
        evidence: `${cycleHoursByRepo.get(slowestCycleRepo.repoId)?.count ?? 0} merged pull requests in this timeframe.`,
        metric: {
          key: `pr-cycle-${slowestCycleRepo.repoId}`,
          label: 'Average PR cycle',
          value: slowestCycleRepo.average,
          better: 'lower',
        },
      })
    }

    const commitsByRepo = commits.reduce((counts, commit) => {
      counts.set(commit.repoId, (counts.get(commit.repoId) ?? 0) + 1)
      return counts
    }, new Map<string, number>())
    const busiestRepo = [...commitsByRepo.entries()].sort((a, b) => b[1] - a[1])[0]
    if (busiestRepo && commits.length >= 10 && busiestRepo[1] / commits.length >= 0.7) {
      const repo = visibleRepos.find((candidate) => candidate.id === busiestRepo[0])
      recommendations.push({
        id: `activity-concentration-${busiestRepo[0]}`,
        severity: 'opportunity',
        title: 'Activity is concentrated in one repository',
        detail: `${repo?.fullName ?? 'One repository'} accounts for ${Math.round((busiestRepo[1] / commits.length) * 100)}% of commits in this period.`,
        actionLabel: 'Inspect repository',
        actionKind: 'inspect',
        repoId: busiestRepo[0],
        ...(repo?.fullName ? { repoFullName: repo.fullName } : {}),
        impact: 'low',
        evidence: `${busiestRepo[1]} of ${commits.length} commits came from this repository.`,
        metric: {
          key: `activity-share-${busiestRepo[0]}`,
          label: 'Workspace commit share',
          value: (busiestRepo[1] / commits.length) * 100,
          better: 'lower',
        },
      })
    }

    if (!recommendations.length) {
      recommendations.push({
        id: 'healthy-workspace',
        severity: 'positive',
        title: 'No urgent action needed',
        detail: 'Sync health, review latency, and pull request cycle time are within the current thresholds.',
        actionLabel: 'Keep monitoring',
        actionKind: 'none',
        impact: 'low',
        evidence: 'No configured sync, review, or cycle-time threshold is currently breached.',
      })
    }

    return {
      windowDays: dayCount,
      activeRepos,
      mergedPullRequests: mergedPullRequests.length,
      averagePrCycleHours,
      averageReviewLatencyHours,
      staleRepos,
      queueDepth: await getQueueDepth(),
      recommendations: recommendations.slice(0, 3),
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
        provider: true,
        providerRepoId: true,
        githubRepoId: true,
        fullName: true,
        isHidden: true,
        lastSyncedAt: true,
        syncStatus: true,
        lastSyncError: true,
        lastSyncStartedAt: true,
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
        provider: repo.provider as 'github' | 'gitea',
        fullName: repo.fullName,
        isHidden: repo.isHidden,
        lastSyncedAt: repo.lastSyncedAt,
        syncStatus: repo.syncStatus,
        lastSyncError: repo.lastSyncError,
        lastSyncStartedAt: repo.lastSyncStartedAt,
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

  app.post('/repos/visibility/restore-all', async (request, reply) => {
    const user = await authenticate(request, reply)
    if (!user) return

    const result = await prisma.repo.updateMany({
      where: { ownerId: user.id, isHidden: true },
      data: { isHidden: false },
    })

    return { restored: result.count }
  })

  app.get<{
    Querystring: { repoId?: string; days?: string; scope?: string }
  }>('/activity', async (request, reply) => {
    const user = await authenticate(request, reply)
    if (!user) {
      return
    }
    const scope = analyticsScope(request.query.scope)

    const { start: requestedStart } = analyticsWindow(request.query.days, 365, 1)
    const end = new Date()

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
        committedAt: { ...(requestedStart ? { gte: requestedStart } : {}), lte: end },
      },
      select: { committedAt: true },
    })

    const start = requestedStart ?? commits.reduce<Date | null>((earliest, commit) => {
      return !earliest || commit.committedAt < earliest ? commit.committedAt : earliest
    }, null) ?? end
    const normalizedStart = new Date(start)
    normalizedStart.setUTCHours(0, 0, 0, 0)

    const counts = new Map<string, number>()
    for (let cursor = new Date(normalizedStart); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
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
