export const getSyncHealthSummary = (queueDepth, staleRepos) => {
  if (queueDepth > 0) {
    return {
      value: `${queueDepth} queued`,
      detail: 'Background sync jobs waiting',
    }
  }

  return {
    value: staleRepos === 0 ? 'Healthy' : `${staleRepos} stale`,
    detail: 'Repos not synced in 7 days',
  }
}

export const getSyncStatusLabel = (status) => (status === 'idle' ? 'new' : status)

export const getQueueNotice = (queued, queueDepth, repoName) => {
  if (queued <= 0) {
    return repoName ? `No sync job queued for ${repoName}.` : 'No repositories were queued.'
  }

  if (repoName) {
    return `Queued ${repoName} for background sync. ${queueDepth} jobs waiting.`
  }

  return `Queued ${queued} repositories for background sync. ${queueDepth} jobs waiting.`
}

export const matchesSyncFilter = (repo, syncFilter) => {
  if (syncFilter === 'all') return true
  if (syncFilter === 'unsynced') return !repo.lastSyncedAt
  return repo.syncStatus === syncFilter
}
