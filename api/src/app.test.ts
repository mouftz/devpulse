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
