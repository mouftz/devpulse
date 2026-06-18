import type { SyncProvider } from './sync-queue.js'

export const providerFromRepoId = (githubRepoId: string): SyncProvider =>
  githubRepoId.startsWith('gitea:') ? 'gitea' : 'github'

export const dueSyncCutoff = (now = new Date(), hours = 23) =>
  new Date(now.getTime() - 1000 * 60 * 60 * hours)

export const shouldEnqueueRepo = ({
  lastSyncedAt,
  syncStatus,
  now = new Date(),
  staleAfterHours = 23,
}: {
  lastSyncedAt: Date | null
  syncStatus: 'idle' | 'queued' | 'syncing' | 'healthy' | 'failed'
  now?: Date
  staleAfterHours?: number
}) => {
  if (syncStatus === 'queued' || syncStatus === 'syncing') {
    return false
  }

  if (!lastSyncedAt) {
    return true
  }

  return lastSyncedAt < dueSyncCutoff(now, staleAfterHours)
}
