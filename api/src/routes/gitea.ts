import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import got from 'got'
import prisma from '../db.js'
import { legacyRepoKey } from '../lib/provider-helpers.js'
import {
  enqueueRepos,
  getQueueDepth,
  markRepoSyncFailed,
  markRepoSyncStarted,
  markRepoSyncSucceeded,
} from '../lib/sync-queue.js'
import { normalizeSyncError } from '../lib/sync-errors.js'
import { mapWithConcurrency } from '../lib/concurrency.js'
import { predictRepoCycleTimes } from '../lib/ml-client.js'

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
  merged?: boolean
  user?: { login?: string; username?: string } | null
  created_at: string
  merged_at: string | null
  closed_at: string | null
}

type GiteaReview = {
  id: number
  state: string
  submitted_at: string
  user?: { login?: string; username?: string } | null
}

type GiteaComment = {
  id: number
  body: string
  created_at: string
  user?: { login?: string; username?: string } | null
}

type GiteaUser = {
  login?: string
  username?: string
}

const PROVIDER_REQUEST_CONCURRENCY = Math.max(1, Math.min(20, Number(process.env.PROVIDER_REQUEST_CONCURRENCY ?? 5)))

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

const providerRepoId = (id: number) => String(id)
const providerCommitSha = (repoId: string, sha: string) => `gitea:${repoId}:${sha}`
const giteaIdentity = (user?: { login?: string; username?: string } | null) => user?.login ?? user?.username ?? null

const giteaMergedAt = (pullRequest: GiteaPullRequest) => {
  const mergedAt = pullRequest.merged_at || (pullRequest.merged || pullRequest.state === 'merged' ? pullRequest.closed_at : null)
  return mergedAt ? new Date(mergedAt) : null
}

const giteaState = (pullRequest: GiteaPullRequest) => (giteaMergedAt(pullRequest) ? 'merged' : pullRequest.state)

const paginateGitea = async <T>(path: string, searchParams: Record<string, string> = {}) => {
  const results: T[] = []
  const limit = Number(searchParams.limit ?? '100')

  for (let page = 1; ; page += 1) {
    const response = await got.get(path, {
      searchParams: {
        limit: String(limit),
        page: String(page),
        ...searchParams,
      },
      headers: giteaHeaders(),
    })
    const items = JSON.parse(String(response.body)) as T[]

    results.push(...items)
    if (items.length < limit) break
  }

  return results
}

export const syncGiteaRepo = async (repo: { id: string; fullName: string }) => {
  await markRepoSyncStarted(repo.id)
  try {
    const [owner, name] = repo.fullName.split('/')
    if (!owner || !name) {
      throw new Error(`Invalid Gitea repo name: ${repo.fullName}`)
    }

    const apiUrl = giteaApiUrl()
    const commits = await paginateGitea<GiteaCommit>(`${apiUrl}/repos/${owner}/${name}/commits`)
    const pullRequests = await paginateGitea<GiteaPullRequest>(`${apiUrl}/repos/${owner}/${name}/pulls`, {
      state: 'all',
    })

    const reviewsByPr = new Map<number, GiteaReview[]>()
    const reviewCommentsByPr = new Map<number, GiteaComment[]>()
    const issueCommentsByPr = new Map<number, GiteaComment[]>()
    await mapWithConcurrency(
      pullRequests,
      PROVIDER_REQUEST_CONCURRENCY,
      async (pullRequest) => {
        try {
          const [reviews, reviewComments, issueComments] = await Promise.all([
            paginateGitea<GiteaReview>(`${apiUrl}/repos/${owner}/${name}/pulls/${pullRequest.number}/reviews`),
            paginateGitea<GiteaComment>(`${apiUrl}/repos/${owner}/${name}/pulls/${pullRequest.number}/comments`),
            paginateGitea<GiteaComment>(`${apiUrl}/repos/${owner}/${name}/issues/${pullRequest.number}/comments`),
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
            where: { sha: providerCommitSha(repo.id, commit.sha) },
            create: {
              repoId: repo.id,
              sha: providerCommitSha(repo.id, commit.sha),
              authorGithubId: giteaIdentity(commit.author) ?? 'ghost',
              message: commit.commit.message,
              committedAt: new Date(commit.commit.committer.date),
            },
            update: {
              authorGithubId: giteaIdentity(commit.author) ?? 'ghost',
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
              state: giteaState(pullRequest),
              authorGithubId: giteaIdentity(pullRequest.user) ?? 'ghost',
              openedAt: new Date(pullRequest.created_at),
              mergedAt: giteaMergedAt(pullRequest),
              closedAt: pullRequest.closed_at ? new Date(pullRequest.closed_at) : null,
            },
            update: {
              title: pullRequest.title,
              state: giteaState(pullRequest),
              authorGithubId: giteaIdentity(pullRequest.user) ?? 'ghost',
              openedAt: new Date(pullRequest.created_at),
              ...(giteaMergedAt(pullRequest) ? { mergedAt: giteaMergedAt(pullRequest) } : {}),
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

          return reviews.map((review) => {
            const submittedAt = new Date(review.submitted_at)
            const openedAt = new Date(sourcePullRequest.created_at)
            const timeToReviewMins = Math.max(0, Math.round((submittedAt.getTime() - openedAt.getTime()) / 1000 / 60))

            return tx.prReview.upsert({
              where: { id: `gitea:${savedPullRequest.id}:${review.id}` },
              create: {
                id: `gitea:${savedPullRequest.id}:${review.id}`,
                prId: savedPullRequest.id,
                reviewerGithubId: giteaIdentity(review.user) ?? 'ghost',
                state: review.state.toLowerCase(),
                timeToReviewMins,
                submittedAt,
              },
              update: {
                reviewerGithubId: giteaIdentity(review.user) ?? 'ghost',
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
              where: { id: `gitea:${savedPullRequest.id}:${isReviewComment ? 'review' : 'issue'}:${comment.id}` },
              create: {
                id: `gitea:${savedPullRequest.id}:${isReviewComment ? 'review' : 'issue'}:${comment.id}`,
                prId: savedPullRequest.id,
                commenterGithubId: giteaIdentity(comment.user) ?? 'ghost',
                kind: isReviewComment ? 'review' : 'issue',
                body: comment.body.slice(0, 4000),
                commentedAt: new Date(comment.created_at),
              },
              update: {
                commenterGithubId: giteaIdentity(comment.user) ?? 'ghost',
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

  app.get('/repos', async (request, reply) => {
    const user = await authenticate(request, reply)
    if (!user) {
      return
    }

    const giteaUser = await got
      .get(`${giteaApiUrl()}/user`, {
        headers: giteaHeaders(),
      })
      .json<GiteaUser>()
    const giteaUsername = giteaIdentity(giteaUser)

    if (giteaUsername) {
      await prisma.user.update({
        where: { id: user.id },
        data: { giteaUsername },
      })
    }

    const repos = await paginateGitea<GiteaRepo>(`${giteaApiUrl()}/user/repos`)

    const savedRepos = await prisma.$transaction(
      repos.map((repo) =>
        prisma.repo.upsert({
          where: {
            provider_providerRepoId: {
              provider: 'gitea',
              providerRepoId: providerRepoId(repo.id),
            },
          },
          create: {
            githubRepoId: legacyRepoKey('gitea', providerRepoId(repo.id)),
            provider: 'gitea',
            providerRepoId: providerRepoId(repo.id),
            ownerId: user.id,
            fullName: repo.full_name,
            defaultBranch: repo.default_branch ?? 'main',
            isPrivate: repo.private,
          },
          update: {
            githubRepoId: legacyRepoKey('gitea', providerRepoId(repo.id)),
            provider: 'gitea',
            providerRepoId: providerRepoId(repo.id),
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
        provider: 'gitea',
        isHidden: false,
      },
      select: { id: true, fullName: true },
      orderBy: { fullName: 'asc' },
    })

    const results = []
    for (const repo of repos) {
      try {
        const result = await syncGiteaRepo(repo)
        results.push({ status: 'synced', ...result })
      } catch (error) {
        results.push({
          status: 'failed',
          repo,
          error: normalizeSyncError(error),
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
        provider: 'gitea',
        isHidden: false,
      },
      select: { id: true, fullName: true },
    })

    if (!repo) {
      return reply.code(404).send({ error: 'Gitea repo not found' })
    }

    return syncGiteaRepo(repo)
  })

  app.post('/repos/sync-all/background', async (request, reply) => {
    const user = await authenticate(request, reply)
    if (!user) {
      return
    }

    const repos = await prisma.repo.findMany({
      where: {
        ownerId: user.id,
        provider: 'gitea',
        isHidden: false,
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
        provider: 'gitea',
        isHidden: false,
      },
      select: { id: true, provider: true, providerRepoId: true, githubRepoId: true, ownerId: true },
    })

    if (!repo) {
      return reply.code(404).send({ error: 'Gitea repo not found' })
    }

    await enqueueRepos([repo], 'manual')
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
        provider: 'gitea',
      },
      select: { id: true, fullName: true },
    })

    if (!repo) {
      return reply.code(404).send({ error: 'Gitea repo not found' })
    }

    await prisma.repo.update({
      where: { id: repo.id },
      data: { isHidden: true },
    })

    return { repo, removed: true }
  })
}
