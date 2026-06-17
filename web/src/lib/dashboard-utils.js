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
