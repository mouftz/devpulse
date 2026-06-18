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

type ManagerFilterableRepo = {
  id: string
  fullName: string
  provider: 'github' | 'gitea'
  isHidden: boolean
  lastSyncedAt: string | null
  lastSyncStartedAt: string | null
  lastSyncFinishedAt: string | null
  lastSyncError: string | null
  commits: number
  pullRequests: number
  syncStatus: 'idle' | 'queued' | 'syncing' | 'healthy' | 'failed'
}

export function filterManagerRepos(
  repos: Array<ManagerFilterableRepo>,
  query: string,
  syncFilter: 'all' | 'healthy' | 'queued' | 'syncing' | 'failed',
  visibilityFilter?: 'all' | 'visible' | 'hidden',
): Array<ManagerFilterableRepo>

export function summarizeManagerRepos(repos: Array<{
  isHidden: boolean
  syncStatus: 'idle' | 'queued' | 'syncing' | 'healthy' | 'failed'
}>): {
  visible: number
  hidden: number
  statuses: {
    healthy: number
    queued: number
    syncing: number
    failed: number
    idle: number
  }
}

export function compareToWorkspaceAverage(
  value: number,
  workspaceTotal: number,
  repoCount: number,
): {
  average: number
  label: string
  tone: 'above' | 'below' | 'neutral'
}
