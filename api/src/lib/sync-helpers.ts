import type { SyncProvider } from './sync-queue.js'

export const providerFromRepoId = (githubRepoId: string): SyncProvider =>
  githubRepoId.startsWith('gitea:') ? 'gitea' : 'github'

export const dueSyncCutoff = (now = new Date(), hours = 23) =>
  new Date(now.getTime() - 1000 * 60 * 60 * hours)
