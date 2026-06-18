export function getSyncHealthSummary(
  queueDepth: number,
  staleRepos: number,
): {
  value: string
  detail: string
}

export function getSyncStatusLabel(
  status: 'idle' | 'queued' | 'syncing' | 'healthy' | 'failed',
): string

export function getQueueNotice(
  queued: number,
  queueDepth: number,
  repoName?: string,
): string

export function matchesSyncFilter(
  repo: {
    lastSyncedAt: string | null
    syncStatus: 'idle' | 'queued' | 'syncing' | 'healthy' | 'failed'
  },
  syncFilter: 'all' | 'healthy' | 'queued' | 'syncing' | 'failed' | 'unsynced',
): boolean
