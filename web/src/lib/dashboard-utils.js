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

export const filterManagerRepos = (repos, query, syncFilter, visibilityFilter = 'all') => {
  const normalizedQuery = query.trim().toLowerCase()

  return repos.filter((repo) => {
    const matchesQuery =
      !normalizedQuery ||
      repo.fullName.toLowerCase().includes(normalizedQuery) ||
      repo.provider.toLowerCase().includes(normalizedQuery)

    const matchesStatus = syncFilter === 'all' || repo.syncStatus === syncFilter
    const matchesVisibility =
      visibilityFilter === 'all' ||
      (visibilityFilter === 'visible' && !repo.isHidden) ||
      (visibilityFilter === 'hidden' && repo.isHidden)

    return matchesQuery && matchesStatus && matchesVisibility
  })
}

export const summarizeManagerRepos = (repos) =>
  repos.reduce(
    (summary, repo) => {
      if (repo.isHidden) {
        summary.hidden += 1
      } else {
        summary.visible += 1
      }
      summary.statuses[repo.syncStatus] += 1
      return summary
    },
    {
      visible: 0,
      hidden: 0,
      statuses: {
        healthy: 0,
        queued: 0,
        syncing: 0,
        failed: 0,
        idle: 0,
      },
    },
  )

export const compareToWorkspaceAverage = (value, workspaceTotal, repoCount) => {
  const average = repoCount > 0 ? workspaceTotal / repoCount : 0
  if (average === 0) {
    return {
      average,
      label: value > 0 ? 'Only active repository' : 'At workspace average',
      tone: value > 0 ? 'above' : 'neutral',
    }
  }

  const difference = ((value - average) / average) * 100
  if (Math.abs(difference) < 1) {
    return { average, label: 'At workspace average', tone: 'neutral' }
  }

  const tone = difference > 0 ? 'above' : 'below'
  return {
    average,
    label: `${Math.abs(Math.round(difference))}% ${tone} average`,
    tone,
  }
}
