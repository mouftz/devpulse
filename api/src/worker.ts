import 'dotenv/config'
import prisma from './db.js'
import { syncGiteaRepo } from './routes/gitea.js'
import { syncGitHubRepo } from './routes/repos.js'
import { enqueueDueRepos, enqueueSyncJob, popSyncJob, type SyncJob } from './lib/sync-queue.js'
import { retryAttempt, retryDelayMs, shouldRetrySyncJob } from './lib/retry-policy.js'
import { trainPrCycleModel } from './lib/ml-client.js'
import { decryptToken } from './lib/token-crypto.js'

const SYNC_INTERVAL_SECONDS = Math.max(60, Number(process.env.SYNC_INTERVAL_SECONDS ?? 86400))
const RUN_ON_START = String(process.env.RUN_ON_START ?? 'true') === 'true'
const SYNC_MAX_ATTEMPTS = Math.max(1, Number(process.env.SYNC_MAX_ATTEMPTS ?? 3))
const SYNC_RETRY_BASE_MS = Math.max(100, Number(process.env.SYNC_RETRY_BASE_MS ?? 5_000))
const SYNC_RETRY_MAX_MS = Math.max(SYNC_RETRY_BASE_MS, Number(process.env.SYNC_RETRY_MAX_MS ?? 60_000))
const ML_TRAIN_INTERVAL_SECONDS = Math.max(3600, Number(process.env.ML_TRAIN_INTERVAL_SECONDS ?? 86400))

const log = (...values: unknown[]) => {
  console.log('[worker]', ...values)
}

const scheduleDueRepos = async (reason: 'nightly' | 'catchup') => {
  const queued = await enqueueDueRepos(reason)
  log(`queued ${queued} repos for ${reason}`)
}

const processJob = async (job: SyncJob) => {
  const repo = await prisma.repo.findUnique({
    where: { id: job.repoId },
    select: { id: true, fullName: true, provider: true, providerRepoId: true, githubRepoId: true, ownerId: true, isHidden: true },
  })
  if (!repo || repo.isHidden) {
    return
  }

  if (job.provider === 'github') {
    const user = await prisma.user.findUnique({
      where: { id: repo.ownerId },
      select: { id: true, username: true, giteaUsername: true, accessToken: true },
    })
    if (!user || !user.accessToken) {
      throw new Error(`GitHub token missing for repo ${repo.fullName}`)
    }
    await syncGitHubRepo({ ...user, accessToken: decryptToken(user.accessToken) }, { id: repo.id, fullName: repo.fullName })
    log(`synced github repo ${repo.fullName}`)
    return
  }

  await syncGiteaRepo({ id: repo.id, fullName: repo.fullName })
  log(`synced gitea repo ${repo.fullName}`)
}

const scheduleRetry = (job: SyncJob, error: unknown) => {
  if (!shouldRetrySyncJob(job, error, SYNC_MAX_ATTEMPTS)) {
    log(`giving up on repo ${job.repoId} after ${retryAttempt(job) + 1} attempt(s)`)
    return
  }

  const attempt = retryAttempt(job) + 1
  const delayMs = retryDelayMs(attempt - 1, SYNC_RETRY_BASE_MS, SYNC_RETRY_MAX_MS)
  log(`retrying repo ${job.repoId} in ${delayMs}ms (attempt ${attempt + 1}/${SYNC_MAX_ATTEMPTS})`)

  setTimeout(() => {
    void enqueueSyncJob({ ...job, attempt, requestedAt: new Date().toISOString() }).catch((retryError) => {
      log(`failed to requeue repo ${job.repoId}`, retryError)
    })
  }, delayMs)
}

const runLoop = async () => {
  if (RUN_ON_START) {
    await scheduleDueRepos('catchup')
    void trainPrCycleModel().then((result) => result && log(`trained ${result.model_kind} model on ${result.training_rows} PRs`))
  }

  setInterval(() => {
    void scheduleDueRepos('nightly').catch((error) => {
      log('failed to queue nightly repos', error)
    })
  }, SYNC_INTERVAL_SECONDS * 1000)

  setInterval(() => {
    void trainPrCycleModel().then((result) => result && log(`trained ${result.model_kind} model on ${result.training_rows} PRs`))
  }, ML_TRAIN_INTERVAL_SECONDS * 1000)

  while (true) {
    const job = await popSyncJob()
    if (!job) continue

    try {
      await processJob(job)
    } catch (error) {
      log('job failed', error)
      scheduleRetry(job, error)
    }
  }
}

void runLoop()
