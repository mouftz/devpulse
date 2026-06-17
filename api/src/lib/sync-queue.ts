import { Redis } from 'ioredis'
import prisma from '../db.js'
import { dueSyncCutoff, providerFromRepoId } from './sync-helpers.js'

export type SyncProvider = 'github' | 'gitea'

export type SyncJob = {
  repoId: string
  provider: SyncProvider
  ownerId: string
  reason: 'manual' | 'nightly' | 'catchup'
  requestedAt: string
}

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379'
const SYNC_QUEUE_KEY = 'devpulse:sync_queue'

let redisClient: Redis | null = null

const redis = () => {
  redisClient ??= new Redis(REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  })
  return redisClient
}

export const queueKey = SYNC_QUEUE_KEY

export const repoProvider = providerFromRepoId

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
  await redis().lpush(SYNC_QUEUE_KEY, JSON.stringify(job))
}

export const enqueueRepoSync = async (
  repo: { id: string; githubRepoId: string; ownerId: string },
  reason: SyncJob['reason'],
) => {
  await enqueueSyncJob({
    repoId: repo.id,
    provider: repoProvider(repo.githubRepoId),
    ownerId: repo.ownerId,
    reason,
    requestedAt: new Date().toISOString(),
  })
}

export const enqueueRepos = async (
  repos: Array<{ id: string; githubRepoId: string; ownerId: string }>,
  reason: SyncJob['reason'],
) => {
  for (const repo of repos) {
    await enqueueRepoSync(repo, reason)
  }
}

export const enqueueDueRepos = async (reason: SyncJob['reason'] = 'nightly') => {
  const repos = await prisma.repo.findMany({
    where: {
      isHidden: false,
      OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: dueSyncCutoff() } }],
      NOT: { syncStatus: { in: ['queued', 'syncing'] } },
    },
    select: { id: true, githubRepoId: true, ownerId: true },
    orderBy: [{ lastSyncedAt: 'asc' }, { createdAt: 'asc' }],
    take: 100,
  })

  await enqueueRepos(repos, reason)
  return repos.length
}

export const popSyncJob = async (): Promise<SyncJob | null> => {
  const result = await redis().brpop(SYNC_QUEUE_KEY, 0)
  const payload = result?.[1]
  if (!payload) return null

  try {
    return JSON.parse(payload) as SyncJob
  } catch {
    return null
  }
}

export const getQueueDepth = async () => redis().llen(SYNC_QUEUE_KEY)
