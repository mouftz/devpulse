import { Redis } from 'ioredis'
import prisma from '../db.js'
import { normalizeRepoProvider, shouldEnqueueRepo } from './sync-helpers.js'

export type SyncProvider = 'github' | 'gitea'

export type SyncJob = {
  repoId: string
  provider: SyncProvider
  ownerId: string
  reason: 'manual' | 'nightly' | 'catchup'
  requestedAt: string
  attempt?: number
}

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379'
const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL?.replace(/\/$/, '')
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN
const SYNC_QUEUE_KEY = 'devpulse:sync_queue'

let redisClient: Redis | null = null
type QueueTransport = {
  push: (payload: string) => Promise<void>
  pop: () => Promise<string | null>
  depth: () => Promise<number>
}

let queueTransportOverride: QueueTransport | null = null

const redis = () => {
  if (!redisClient) {
    redisClient = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 1,
      enableReadyCheck: false,
      lazyConnect: true,
      retryStrategy: () => null,
    })
    redisClient.on('error', () => {})
    redisClient.on('end', () => {
      redisClient = null
    })
  }
  return redisClient
}

export const queueKey = SYNC_QUEUE_KEY

export const repoProvider = normalizeRepoProvider

const upstashCommand = async <T>(...command: string[]): Promise<T> => {
  if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
    throw new Error('Upstash REST is not configured')
  }

  const response = await fetch(UPSTASH_REDIS_REST_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  })
  const body = await response.json() as { result?: T; error?: string }
  if (!response.ok || body.error) {
    throw new Error(body.error ?? `Upstash returned ${response.status}`)
  }
  return body.result as T
}

const upstashTransport: QueueTransport = {
  push: async (payload) => {
    await upstashCommand<number>('LPUSH', SYNC_QUEUE_KEY, payload)
  },
  pop: () => upstashCommand<string | null>('RPOP', SYNC_QUEUE_KEY),
  depth: () => upstashCommand<number>('LLEN', SYNC_QUEUE_KEY),
}

const queueTransport = (): QueueTransport =>
  queueTransportOverride ?? (UPSTASH_REDIS_REST_URL && UPSTASH_REDIS_REST_TOKEN ? upstashTransport : {
    push: async (payload: string) => {
      await redis().lpush(SYNC_QUEUE_KEY, payload)
    },
    pop: async () => {
      // Managed Redis providers may close blocking commands during idle
      // periods. Non-blocking polling keeps the API worker portable.
      return redis().rpop(SYNC_QUEUE_KEY)
    },
    depth: async () => redis().llen(SYNC_QUEUE_KEY),
  })

export const setQueueTransportForTests = (transport: QueueTransport | null) => {
  queueTransportOverride = transport
}

export const markRepoQueued = async (repoId: string) => {
  await prisma.repo.update({
    where: { id: repoId },
    data: {
      syncStatus: 'queued',
      lastSyncError: null,
    },
  })
}

export const markRepoSyncStarted = async (repoId: string) => {
  await prisma.repo.update({
    where: { id: repoId },
    data: {
      syncStatus: 'syncing',
      lastSyncError: null,
      lastSyncStartedAt: new Date(),
    },
  })
}

export const markRepoSyncSucceeded = async (repoId: string) => {
  await prisma.repo.update({
    where: { id: repoId },
    data: {
      syncStatus: 'healthy',
      lastSyncError: null,
      lastSyncFinishedAt: new Date(),
      lastSyncedAt: new Date(),
    },
  })
}

export const markRepoSyncFailed = async (repoId: string, error: string) => {
  await prisma.repo.update({
    where: { id: repoId },
    data: {
      syncStatus: 'failed',
      lastSyncError: error.slice(0, 2000),
      lastSyncFinishedAt: new Date(),
    },
  })
}

export const enqueueSyncJob = async (job: SyncJob) => {
  await markRepoQueued(job.repoId)
  await queueTransport().push(JSON.stringify(job))
}

export const enqueueRepoSync = async (
  repo: { id: string; provider?: string | null; providerRepoId?: string | null; githubRepoId?: string | null; ownerId: string },
  reason: SyncJob['reason'],
) => {
  await enqueueSyncJob({
    repoId: repo.id,
    provider: repoProvider(repo.provider, repo.githubRepoId, repo.providerRepoId),
    ownerId: repo.ownerId,
    reason,
    requestedAt: new Date().toISOString(),
  })
}

export const enqueueRepos = async (
  repos: Array<{ id: string; provider?: string | null; providerRepoId?: string | null; githubRepoId?: string | null; ownerId: string }>,
  reason: SyncJob['reason'],
) => {
  for (const repo of repos) {
    await enqueueRepoSync(repo, reason)
  }
}

export const enqueueDueRepos = async (reason: SyncJob['reason'] = 'nightly') => {
  const repos = await prisma.repo.findMany({
    where: { isHidden: false },
    select: { id: true, provider: true, providerRepoId: true, githubRepoId: true, ownerId: true, lastSyncedAt: true, syncStatus: true },
    orderBy: [{ lastSyncedAt: 'asc' }, { createdAt: 'asc' }],
    take: 100,
  })

  const dueRepos = repos.filter((repo) =>
    shouldEnqueueRepo({
      lastSyncedAt: repo.lastSyncedAt,
      syncStatus: repo.syncStatus as 'idle' | 'queued' | 'syncing' | 'healthy' | 'failed',
    }),
  )

  await enqueueRepos(dueRepos, reason)
  return dueRepos.length
}

export const parseSyncJob = (payload: string): SyncJob | null => {
  try {
    const value = JSON.parse(payload) as Partial<SyncJob>
    const validProvider = value.provider === 'github' || value.provider === 'gitea'
    const validReason = value.reason === 'manual' || value.reason === 'nightly' || value.reason === 'catchup'
    const validAttempt = value.attempt === undefined || (Number.isInteger(value.attempt) && value.attempt >= 0)

    if (
      typeof value.repoId !== 'string' || !value.repoId.trim() ||
      typeof value.ownerId !== 'string' || !value.ownerId.trim() ||
      typeof value.requestedAt !== 'string' || Number.isNaN(Date.parse(value.requestedAt)) ||
      !validProvider || !validReason || !validAttempt
    ) {
      return null
    }

    return value as SyncJob
  } catch {
    return null
  }
}

export const popSyncJob = async (): Promise<SyncJob | null> => {
  const payload = await queueTransport().pop()
  if (!payload) return null
  return parseSyncJob(payload)
}

export const getQueueDepth = async () => {
  try {
    return await queueTransport().depth()
  } catch {
    return 0
  }
}
