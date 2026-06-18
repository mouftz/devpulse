import type { SyncProvider } from './sync-queue.js'

export const legacyRepoKey = (provider: SyncProvider, providerRepoId: string) =>
  provider === 'gitea' ? `gitea:${providerRepoId}` : providerRepoId

export const normalizeProviderRepoId = (providerRepoId?: string | null, githubRepoId?: string | null) => {
  if (providerRepoId) return providerRepoId
  if (!githubRepoId) return null
  return githubRepoId.startsWith('gitea:') ? githubRepoId.slice('gitea:'.length) : githubRepoId
}
