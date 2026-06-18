import 'dotenv/config'
import prisma from './db.js'
import { syncGiteaRepo } from './routes/gitea.js'
import { syncGitHubRepo } from './routes/repos.js'
import { enqueueDueRepos, popSyncJob } from './lib/sync-queue.js'

const SYNC_INTERVAL_SECONDS = Math.max(60, Number(process.env.SYNC_INTERVAL_SECONDS ?? 86400))
const RUN_ON_START = String(process.env.RUN_ON_START ?? 'true') === 'true'

const log = (...values: unknown[]) => {
  console.log('[worker]', ...values)
}

const scheduleDueRepos = async (reason: 'nightly' | 'catchup') => {
  const queued = await enqueueDueRepos(reason)
  log(`queued ${queued} repos for ${reason}`)
}

const processJob = async () => {
  const job = await popSyncJob()
  if (!job) return

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
    await syncGitHubRepo(user, { id: repo.id, fullName: repo.fullName })
    log(`synced github repo ${repo.fullName}`)
    return
  }

  await syncGiteaRepo({ id: repo.id, fullName: repo.fullName })
  log(`synced gitea repo ${repo.fullName}`)
}

const runLoop = async () => {
  if (RUN_ON_START) {
    await scheduleDueRepos('catchup')
  }

  setInterval(() => {
    void scheduleDueRepos('nightly').catch((error) => {
      log('failed to queue nightly repos', error)
    })
  }, SYNC_INTERVAL_SECONDS * 1000)

  while (true) {
    try {
      await processJob()
    } catch (error) {
      log('job failed', error)
    }
  }
}

void runLoop()
