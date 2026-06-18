import assert from 'node:assert/strict'
import test from 'node:test'
import { createApp } from './app.js'
import prisma from './db.js'

const authCookie = async (app: ReturnType<typeof createApp>, userId = 'user-1') => ({
  devpulse_token: await (async () => {
    await app.ready()
    return app.jwt.sign({ sub: userId, githubId: 'gh-1' })
  })(),
})

test('GET /health returns ok', async () => {
  const app = createApp()
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
    })

    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { status: 'ok' })
  } finally {
    await app.close()
  }
})

test('GET /auth/me rejects missing session', async () => {
  const app = createApp()
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/auth/me',
    })

    assert.equal(response.statusCode, 401)
    assert.deepEqual(response.json(), { error: 'Not authenticated' })
  } finally {
    await app.close()
  }
})

test('GET /auth/me rejects invalid session cookie', async () => {
  const app = createApp()
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/auth/me',
      cookies: {
        devpulse_token: 'not-a-real-token',
      },
    })

    assert.equal(response.statusCode, 401)
    assert.deepEqual(response.json(), { error: 'Invalid session' })
  } finally {
    await app.close()
  }
})

test('POST /auth/logout clears the session cookie', async () => {
  const app = createApp()
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/logout',
    })

    const setCookie = Array.isArray(response.headers['set-cookie'])
      ? response.headers['set-cookie'].join(';')
      : (response.headers['set-cookie'] ?? '')

    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { message: 'Logged out' })
    assert.match(setCookie, /devpulse_token=;/)
  } finally {
    await app.close()
  }
})

test('POST /auth/unlink/github clears the saved GitHub token', async () => {
  const app = createApp()
  const originalUserUpdate = prisma.user.update

  prisma.user.update = (async () =>
    ({
      id: 'user-1',
    })) as unknown as typeof prisma.user.update

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/unlink/github',
      cookies: await authCookie(app),
    })

    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { provider: 'github', connected: false })
  } finally {
    prisma.user.update = originalUserUpdate
    await app.close()
  }
})

test('POST /auth/unlink/gitea clears the saved Gitea username', async () => {
  const app = createApp()
  const originalUserUpdate = prisma.user.update

  prisma.user.update = (async () =>
    ({
      id: 'user-1',
    })) as unknown as typeof prisma.user.update

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/unlink/gitea',
      cookies: await authCookie(app),
    })

    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { provider: 'gitea', connected: false })
  } finally {
    prisma.user.update = originalUserUpdate
    await app.close()
  }
})

test('GET /auth/system returns API, sync, and provider status for an authenticated session', async () => {
  const app = createApp()

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/auth/system',
      cookies: await authCookie(app),
    })

    assert.equal(response.statusCode, 200)
    const payload = response.json()
    assert.equal(payload.api.status, 'ok')
    assert.equal(typeof payload.api.port, 'number')
    assert.equal(typeof payload.sync.intervalSeconds, 'number')
    assert.equal(typeof payload.sync.runOnStart, 'boolean')
    assert.equal(payload.sync.queueDepth, 0)
    assert.equal(typeof payload.providers.githubOauthConfigured, 'boolean')
    assert.equal(typeof payload.providers.giteaConfigured, 'boolean')
  } finally {
    await app.close()
  }
})

test('GET /github/overview rejects missing bearer or session auth', async () => {
  const app = createApp()
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/github/overview',
    })

    assert.equal(response.statusCode, 401)
    assert.deepEqual(response.json(), { error: 'Missing bearer token' })
  } finally {
    await app.close()
  }
})

test('POST /github/repos/:repoId/visibility validates isHidden for authenticated requests', async () => {
  const app = createApp()
  const originalFindUnique = prisma.user.findUnique

  prisma.user.findUnique = (async () =>
    ({
      id: 'user-1',
      username: 'mouftz',
      giteaUsername: null,
      accessToken: 'token',
    })) as unknown as typeof prisma.user.findUnique

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/github/repos/repo-1/visibility',
      cookies: await authCookie(app),
      payload: {},
    })

    assert.equal(response.statusCode, 400)
    assert.deepEqual(response.json(), { error: 'isHidden boolean is required' })
  } finally {
    prisma.user.findUnique = originalFindUnique
    await app.close()
  }
})

test('GET /github/overview returns repo metrics for an authenticated user', async () => {
  const app = createApp()
  const originalUserFindUnique = prisma.user.findUnique
  const originalRepoFindMany = prisma.repo.findMany
  const originalCommitCount = prisma.commit.count
  const originalPullRequestCount = prisma.pullRequest.count

  prisma.user.findUnique = (async () =>
    ({
      id: 'user-1',
      username: 'mouftz',
      giteaUsername: null,
      accessToken: 'token',
    })) as unknown as typeof prisma.user.findUnique

  prisma.repo.findMany = (async () =>
    ([
      {
        id: 'repo-1',
        provider: 'github',
        providerRepoId: '123',
        githubRepoId: '123',
        fullName: 'mouftz/devpulse',
        lastSyncedAt: new Date('2026-06-17T12:00:00.000Z'),
        syncStatus: 'healthy',
        lastSyncError: null,
        lastSyncStartedAt: new Date('2026-06-17T11:59:00.000Z'),
        lastSyncFinishedAt: new Date('2026-06-17T12:00:00.000Z'),
      },
    ])) as unknown as typeof prisma.repo.findMany

  prisma.commit.count = (async () => 9) as unknown as typeof prisma.commit.count
  prisma.pullRequest.count = (async () => 2) as unknown as typeof prisma.pullRequest.count

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/github/overview',
      cookies: await authCookie(app),
    })

    assert.equal(response.statusCode, 200)
    const payload = response.json()
    assert.equal(payload.totals.repos, 1)
    assert.equal(payload.totals.commits, 9)
    assert.equal(payload.totals.pullRequests, 2)
    assert.equal(payload.repos[0].fullName, 'mouftz/devpulse')
    assert.equal(payload.repos[0].lastSyncStartedAt, '2026-06-17T11:59:00.000Z')
  } finally {
    prisma.user.findUnique = originalUserFindUnique
    prisma.repo.findMany = originalRepoFindMany
    prisma.commit.count = originalCommitCount
    prisma.pullRequest.count = originalPullRequestCount
    await app.close()
  }
})

test('GET /github/repos/manage returns visible and hidden repos with counts', async () => {
  const app = createApp()
  const originalUserFindUnique = prisma.user.findUnique
  const originalRepoFindMany = prisma.repo.findMany
  const originalCommitCount = prisma.commit.count
  const originalPullRequestCount = prisma.pullRequest.count

  prisma.user.findUnique = (async () =>
    ({
      id: 'user-1',
      username: 'mouftz',
      giteaUsername: 'mouftz',
      accessToken: 'token',
    })) as unknown as typeof prisma.user.findUnique

  prisma.repo.findMany = (async () =>
    ([
      {
        id: 'repo-1',
        provider: 'github',
        providerRepoId: '123',
        githubRepoId: '123',
        fullName: 'mouftz/devpulse',
        isHidden: false,
        lastSyncedAt: new Date('2026-06-17T12:00:00.000Z'),
        syncStatus: 'healthy',
        lastSyncError: null,
        lastSyncStartedAt: new Date('2026-06-17T11:59:00.000Z'),
      },
      {
        id: 'repo-2',
        provider: 'gitea',
        providerRepoId: '44',
        githubRepoId: 'gitea:44',
        fullName: 'iqbank/iqbank',
        isHidden: true,
        lastSyncedAt: null,
        syncStatus: 'idle',
        lastSyncError: null,
        lastSyncStartedAt: null,
      },
    ])) as unknown as typeof prisma.repo.findMany

  prisma.commit.count = (async ({ where }: { where: { repoId: string } }) =>
    where.repoId === 'repo-1' ? 9 : 1) as unknown as typeof prisma.commit.count
  prisma.pullRequest.count = (async ({ where }: { where: { repoId: string } }) =>
    where.repoId === 'repo-1' ? 2 : 0) as unknown as typeof prisma.pullRequest.count

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/github/repos/manage',
      cookies: await authCookie(app),
    })

    assert.equal(response.statusCode, 200)
    const payload = response.json()
    assert.equal(payload.repos.length, 2)
    assert.equal(payload.repos[0].fullName, 'mouftz/devpulse')
    assert.equal(payload.repos[0].commits, 9)
    assert.equal(payload.repos[1].isHidden, true)
    assert.equal(payload.repos[1].provider, 'gitea')
  } finally {
    prisma.user.findUnique = originalUserFindUnique
    prisma.repo.findMany = originalRepoFindMany
    prisma.commit.count = originalCommitCount
    prisma.pullRequest.count = originalPullRequestCount
    await app.close()
  }
})

test('GET /gitea/repos rejects missing bearer or session auth', async () => {
  const app = createApp()
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/gitea/repos',
    })

    assert.equal(response.statusCode, 401)
    assert.deepEqual(response.json(), { error: 'Missing bearer token' })
  } finally {
    await app.close()
  }
})

test('POST /gitea/repos/:repoId/sync returns 404 when the repo is not accessible', async () => {
  const app = createApp()
  const originalUserFindUnique = prisma.user.findUnique
  const originalRepoFindFirst = prisma.repo.findFirst

  prisma.user.findUnique = (async () =>
    ({
      id: 'user-1',
    })) as unknown as typeof prisma.user.findUnique

  prisma.repo.findFirst = (async () => null) as unknown as typeof prisma.repo.findFirst

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/gitea/repos/repo-404/sync',
      cookies: await authCookie(app),
    })

    assert.equal(response.statusCode, 404)
    assert.deepEqual(response.json(), { error: 'Gitea repo not found' })
  } finally {
    prisma.user.findUnique = originalUserFindUnique
    prisma.repo.findFirst = originalRepoFindFirst
    await app.close()
  }
})

test('DELETE /gitea/repos/:repoId hides a repo owned by the authenticated user', async () => {
  const app = createApp()
  const originalUserFindUnique = prisma.user.findUnique
  const originalRepoFindFirst = prisma.repo.findFirst
  const originalRepoUpdate = prisma.repo.update

  prisma.user.findUnique = (async () =>
    ({
      id: 'user-1',
    })) as unknown as typeof prisma.user.findUnique

  prisma.repo.findFirst = (async () =>
    ({
      id: 'repo-1',
      fullName: 'iqbank/iqbank',
    })) as unknown as typeof prisma.repo.findFirst

  prisma.repo.update = (async () =>
    ({
      id: 'repo-1',
      fullName: 'iqbank/iqbank',
      isHidden: true,
    })) as unknown as typeof prisma.repo.update

  try {
    const response = await app.inject({
      method: 'DELETE',
      url: '/gitea/repos/repo-1',
      cookies: await authCookie(app),
    })

    assert.equal(response.statusCode, 200)
    const payload = response.json()
    assert.equal(payload.removed, true)
    assert.equal(payload.repo.id, 'repo-1')
    assert.equal(payload.repo.fullName, 'iqbank/iqbank')
  } finally {
    prisma.user.findUnique = originalUserFindUnique
    prisma.repo.findFirst = originalRepoFindFirst
    prisma.repo.update = originalRepoUpdate
    await app.close()
  }
})

test('GET /github/activity returns daily commit buckets for authenticated requests', async () => {
  const app = createApp()
  const originalUserFindUnique = prisma.user.findUnique
  const originalCommitFindMany = prisma.commit.findMany

  prisma.user.findUnique = (async () =>
    ({
      id: 'user-1',
      username: 'mouftz',
      giteaUsername: null,
      accessToken: 'token',
    })) as unknown as typeof prisma.user.findUnique

  prisma.commit.findMany = (async () =>
    ([
      { committedAt: new Date('2026-06-15T12:00:00.000Z') },
      { committedAt: new Date('2026-06-15T18:30:00.000Z') },
      { committedAt: new Date('2026-06-17T09:00:00.000Z') },
    ])) as unknown as typeof prisma.commit.findMany

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/github/activity?days=3',
      cookies: await authCookie(app),
    })

    assert.equal(response.statusCode, 200)
    const payload = response.json()
    assert.equal(payload.total, 3)
    const countsByDate = new Map(
      payload.days.map((day: { date: string; count: number }) => [day.date, day.count]),
    )
    const counts = [...countsByDate.values()] as number[]
    assert.equal(countsByDate.get('2026-06-15'), 2)
    assert.equal(countsByDate.get('2026-06-17'), 1)
    assert.equal(counts.reduce((sum, count) => sum + count, 0), 3)
  } finally {
    prisma.user.findUnique = originalUserFindUnique
    prisma.commit.findMany = originalCommitFindMany
    await app.close()
  }
})

test('GET /github/repos/:repoId/summary returns repo metrics for an authenticated user', async () => {
  const app = createApp()
  const originalUserFindUnique = prisma.user.findUnique
  const originalRepoFindFirst = prisma.repo.findFirst
  const originalCommitCount = prisma.commit.count
  const originalPullRequestCount = prisma.pullRequest.count
  const originalPullRequestFindMany = prisma.pullRequest.findMany

  prisma.user.findUnique = (async () =>
    ({
      id: 'user-1',
      username: 'mouftz',
      giteaUsername: null,
      accessToken: 'token',
    })) as unknown as typeof prisma.user.findUnique

  prisma.repo.findFirst = (async () =>
    ({
      id: 'repo-1',
      provider: 'github',
      providerRepoId: '123',
      githubRepoId: '123',
      fullName: 'mouftz/devpulse',
      lastSyncedAt: new Date('2026-06-17T12:00:00.000Z'),
      syncStatus: 'healthy',
      lastSyncError: null,
      lastSyncStartedAt: new Date('2026-06-17T11:59:00.000Z'),
      lastSyncFinishedAt: new Date('2026-06-17T12:00:00.000Z'),
    })) as unknown as typeof prisma.repo.findFirst

  prisma.commit.count = (async () => 9) as unknown as typeof prisma.commit.count
  prisma.pullRequest.count = (async () => 3) as unknown as typeof prisma.pullRequest.count
  prisma.pullRequest.findMany = (async () =>
    ([
      {
        openedAt: new Date('2026-06-14T10:00:00.000Z'),
        mergedAt: new Date('2026-06-14T22:00:00.000Z'),
      },
      {
        openedAt: new Date('2026-06-16T09:00:00.000Z'),
        mergedAt: new Date('2026-06-17T09:00:00.000Z'),
      },
    ])) as unknown as typeof prisma.pullRequest.findMany

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/github/repos/repo-1/summary',
      cookies: await authCookie(app),
    })

    assert.equal(response.statusCode, 200)
    const payload = response.json()
    assert.equal(payload.repo.fullName, 'mouftz/devpulse')
    assert.equal(payload.metrics.commits, 9)
    assert.equal(payload.metrics.pullRequests, 3)
    assert.equal(payload.metrics.mergedPullRequests, 2)
    assert.equal(payload.metrics.averagePrCycleHours, 18)
  } finally {
    prisma.user.findUnique = originalUserFindUnique
    prisma.repo.findFirst = originalRepoFindFirst
    prisma.commit.count = originalCommitCount
    prisma.pullRequest.count = originalPullRequestCount
    prisma.pullRequest.findMany = originalPullRequestFindMany
    await app.close()
  }
})

test('GET /github/insights returns aggregate analytics for an authenticated user', async () => {
  const app = createApp()
  const originalUserFindUnique = prisma.user.findUnique
  const originalRepoFindMany = prisma.repo.findMany
  const originalCommitFindMany = prisma.commit.findMany
  const originalPullRequestFindMany = prisma.pullRequest.findMany

  prisma.user.findUnique = (async () =>
    ({
      id: 'user-1',
      username: 'mouftz',
      giteaUsername: null,
      accessToken: 'token',
    })) as unknown as typeof prisma.user.findUnique

  prisma.repo.findMany = (async () =>
    ([
      {
        id: 'repo-1',
        lastSyncedAt: new Date('2026-06-17T12:00:00.000Z'),
      },
      {
        id: 'repo-2',
        lastSyncedAt: null,
      },
    ])) as unknown as typeof prisma.repo.findMany

  let pullRequestCall = 0

  prisma.commit.findMany = (async () =>
    ([
      { repoId: 'repo-1' },
      { repoId: 'repo-1' },
      { repoId: 'repo-2' },
    ])) as unknown as typeof prisma.commit.findMany

  prisma.pullRequest.findMany = (async () => {
    pullRequestCall += 1
    if (pullRequestCall === 1) {
      return [
        {
          openedAt: new Date('2026-06-14T10:00:00.000Z'),
          mergedAt: new Date('2026-06-14T22:00:00.000Z'),
        },
        {
          openedAt: new Date('2026-06-16T08:00:00.000Z'),
          mergedAt: new Date('2026-06-16T20:00:00.000Z'),
        },
      ]
    }

    return [
      {
        reviews: [{ timeToReviewMins: 120 }],
      },
      {
        reviews: [{ timeToReviewMins: 360 }],
      },
    ]
  }) as unknown as typeof prisma.pullRequest.findMany

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/github/insights?days=30',
      cookies: await authCookie(app),
    })

    assert.equal(response.statusCode, 200)
    const payload = response.json()
    assert.equal(payload.windowDays, 30)
    assert.equal(payload.activeRepos, 2)
    assert.equal(payload.mergedPullRequests, 2)
    assert.equal(payload.averagePrCycleHours, 12)
    assert.equal(payload.averageReviewLatencyHours, 4)
    assert.equal(payload.staleRepos, 1)
    assert.equal(payload.queueDepth, 0)
  } finally {
    prisma.user.findUnique = originalUserFindUnique
    prisma.repo.findMany = originalRepoFindMany
    prisma.commit.findMany = originalCommitFindMany
    prisma.pullRequest.findMany = originalPullRequestFindMany
    await app.close()
  }
})

test('GET /github/repos/:repoId/pr-cycle returns weekly cycle-time analytics', async () => {
  const app = createApp()
  const originalUserFindUnique = prisma.user.findUnique
  const originalRepoFindFirst = prisma.repo.findFirst
  const originalPullRequestFindMany = prisma.pullRequest.findMany

  prisma.user.findUnique = (async () =>
    ({
      id: 'user-1',
      username: 'mouftz',
      giteaUsername: null,
      accessToken: 'token',
    })) as unknown as typeof prisma.user.findUnique

  prisma.repo.findFirst = (async () =>
    ({
      id: 'repo-1',
    })) as unknown as typeof prisma.repo.findFirst

  prisma.pullRequest.findMany = (async () =>
    ([
      {
        openedAt: new Date('2026-06-09T10:00:00.000Z'),
        mergedAt: new Date('2026-06-09T22:00:00.000Z'),
      },
      {
        openedAt: new Date('2026-06-10T10:00:00.000Z'),
        mergedAt: new Date('2026-06-11T10:00:00.000Z'),
      },
      {
        openedAt: new Date('2026-06-16T08:00:00.000Z'),
        mergedAt: new Date('2026-06-18T08:00:00.000Z'),
      },
    ])) as unknown as typeof prisma.pullRequest.findMany

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/github/repos/repo-1/pr-cycle?days=30',
      cookies: await authCookie(app),
    })

    assert.equal(response.statusCode, 200)
    const payload = response.json()
    assert.equal(payload.averageHours, 28)
    assert.equal(payload.trend, 'slowing')
    assert.equal(payload.deltaHours, 30)
    assert.equal(payload.weeks.length, 2)
    assert.deepEqual(payload.weeks, [
      { week: '2026-06-07', averageHours: 18, mergedPrs: 2 },
      { week: '2026-06-14', averageHours: 48, mergedPrs: 1 },
    ])
  } finally {
    prisma.user.findUnique = originalUserFindUnique
    prisma.repo.findFirst = originalRepoFindFirst
    prisma.pullRequest.findMany = originalPullRequestFindMany
    await app.close()
  }
})

test('GET /github/repos/:repoId/review-latency returns weekly first-review analytics', async () => {
  const app = createApp()
  const originalUserFindUnique = prisma.user.findUnique
  const originalRepoFindFirst = prisma.repo.findFirst
  const originalPullRequestFindMany = prisma.pullRequest.findMany

  prisma.user.findUnique = (async () =>
    ({
      id: 'user-1',
      username: 'mouftz',
      giteaUsername: null,
      accessToken: 'token',
    })) as unknown as typeof prisma.user.findUnique

  prisma.repo.findFirst = (async () =>
    ({
      id: 'repo-1',
    })) as unknown as typeof prisma.repo.findFirst

  prisma.pullRequest.findMany = (async () =>
    ([
      {
        id: 'pr-1',
        openedAt: new Date('2026-06-09T10:00:00.000Z'),
        reviews: [
          {
            timeToReviewMins: 120,
            submittedAt: new Date('2026-06-09T12:00:00.000Z'),
          },
        ],
      },
      {
        id: 'pr-2',
        openedAt: new Date('2026-06-10T10:00:00.000Z'),
        reviews: [
          {
            timeToReviewMins: 360,
            submittedAt: new Date('2026-06-10T16:00:00.000Z'),
          },
        ],
      },
      {
        id: 'pr-3',
        openedAt: new Date('2026-06-16T08:00:00.000Z'),
        reviews: [
          {
            timeToReviewMins: 180,
            submittedAt: new Date('2026-06-16T11:00:00.000Z'),
          },
        ],
      },
    ])) as unknown as typeof prisma.pullRequest.findMany

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/github/repos/repo-1/review-latency?days=30',
      cookies: await authCookie(app),
    })

    assert.equal(response.statusCode, 200)
    const payload = response.json()
    assert.equal(payload.averageHours, 11 / 3)
    assert.equal(payload.reviewedPullRequests, 3)
    assert.deepEqual(payload.weeks, [
      { week: '2026-06-07', averageHours: 4, reviewedPrs: 2 },
      { week: '2026-06-14', averageHours: 3, reviewedPrs: 1 },
    ])
  } finally {
    prisma.user.findUnique = originalUserFindUnique
    prisma.repo.findFirst = originalRepoFindFirst
    prisma.pullRequest.findMany = originalPullRequestFindMany
    await app.close()
  }
})
