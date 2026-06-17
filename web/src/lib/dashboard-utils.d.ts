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
