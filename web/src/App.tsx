import { useEffect, useMemo, useState } from 'react'
import {
  Activity,
  ArrowUpRight,
  CheckCircle2,
  Flame,
  GitBranch,
  Github,
  Link2Off,
  Loader2,
  LogOut,
  Search,
  Settings2,
  RefreshCw,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react'
import { AuthLanding } from './components/AuthLanding'
import { WorkspaceSessionMenu } from './components/WorkspaceSessionMenu'
import {
  getQueueNotice,
  getSyncHealthSummary,
  getSyncStatusLabel,
  matchesSyncFilter,
} from './lib/dashboard-utils.js'

const API_URL = 'http://localhost:3000'

type User = {
  id: string
  githubId: string
  username: string
  giteaUsername: string | null
  email: string
  avatarUrl: string | null
  githubConnected: boolean
  giteaConnected: boolean
}

type Overview = {
  totals: {
    repos: number
    syncedRepos: number
    commits: number
    pullRequests: number
  }
  repos: Array<{
    id: string
    provider: 'github' | 'gitea'
    fullName: string
    lastSyncedAt: string | null
    lastSyncFinishedAt: string | null
    syncStatus: 'idle' | 'queued' | 'syncing' | 'healthy' | 'failed'
    lastSyncError: string | null
    commits: number
    pullRequests: number
  }>
}

type ManagerRepo = Overview['repos'][number] & {
  isHidden: boolean
}

type ActivityDay = {
  date: string
  count: number
}

type ChartBucket = {
  key: string
  label: string
  count: number
}

type LinePoint = {
  key: string
  label: string
  value: number
}

type ActivitySummary = {
  total: number
  days: ActivityDay[]
}

type RepoSummary = {
  repo: {
    id: string
    fullName: string
    lastSyncedAt: string | null
  }
  metrics: {
    commits: number
    pullRequests: number
    mergedPullRequests: number
    averagePrCycleHours: number | null
  }
}

type PrCycleTrend = {
  averageHours: number | null
  trend: 'improving' | 'slowing' | 'steady'
  deltaHours: number | null
  weeks: Array<{
    week: string
    averageHours: number
    mergedPrs: number
  }>
}

type ReviewLatency = {
  averageHours: number | null
  reviewedPullRequests: number
  weeks: Array<{
    week: string
    averageHours: number
    reviewedPrs: number
  }>
}

type SyncAllResult = {
  total: number
  synced: number
  failed: number
  results?: Array<{
    status: 'synced' | 'failed'
    repo?: {
      id: string
      fullName: string
    }
    error?: string
  }>
}

type SystemStatus = {
  api: {
    status: string
    nodeEnv: string
    host: string
    port: number
  }
  sync: {
    intervalSeconds: number
    runOnStart: boolean
    queueDepth: number
  }
  providers: {
    githubOauthConfigured: boolean
    giteaConfigured: boolean
  }
}

type DashboardInsights = {
  windowDays: number
  activeRepos: number
  mergedPullRequests: number
  averagePrCycleHours: number | null
  averageReviewLatencyHours: number | null
  staleRepos: number
  queueDepth: number
}

type LoadState = 'idle' | 'loading' | 'ready' | 'error'
type RepoSort = 'recent' | 'commits' | 'unsynced'
type RangeDays = 30 | 90 | 365
type AnalyticsScope = 'mine' | 'all'
type RepoProviderFilter = 'all' | 'github' | 'gitea'
type RepoSyncFilter = 'all' | 'healthy' | 'queued' | 'syncing' | 'failed' | 'unsynced'

const errorMessage = (error: unknown) => {
  if (!(error instanceof Error)) return 'Something went wrong.'
  try {
    const parsed = JSON.parse(error.message) as { error?: string; message?: string }
    return parsed.error ?? parsed.message ?? error.message
  } catch {
    return error.message
  }
}

const syncFailures = (provider: string, result: SyncAllResult) =>
  result.results
    ?.filter((entry) => entry.status === 'failed')
    .map((entry) => `${provider}: ${entry.repo?.fullName ?? 'unknown repo'}${entry.error ? ` (${entry.error})` : ''}`) ?? []

const failedSyncResult = (error: unknown): SyncAllResult => ({
  total: 0,
  synced: 0,
  failed: 1,
  results: [{ status: 'failed', error: errorMessage(error) }],
})

const api = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(`${API_URL}${path}`, {
    credentials: 'include',
    ...init,
  })

  if (!response.ok) {
    throw new Error(await response.text())
  }

  return response.json() as Promise<T>
}

const formatDate = (value: string | null) => {
  if (!value) return 'Not synced'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value))
}

const formatSyncDetail = (
  repo: Overview['repos'][number] | null,
  fallbackLastSyncedAt?: string | null,
) => {
  if (!repo) return 'No sync history yet.'
  if (repo.syncStatus === 'failed') return repo.lastSyncError ?? 'Last sync attempt failed.'
  if (repo.syncStatus === 'queued') return 'Queued for background sync.'
  if (repo.syncStatus === 'syncing') return 'Background sync is running now.'

  const finishedAt = repo.lastSyncFinishedAt ?? fallbackLastSyncedAt ?? repo.lastSyncedAt
  return finishedAt ? `Finished ${formatDate(finishedAt)}.` : 'No sync history yet.'
}

const formatSyncTimestamp = (repo: Overview['repos'][number]) => {
  if (repo.lastSyncFinishedAt) return `Finished ${formatDate(repo.lastSyncFinishedAt)}`
  if (repo.lastSyncedAt) return `Last synced ${formatDate(repo.lastSyncedAt)}`
  return 'No completed sync yet'
}

export function App() {
  const [user, setUser] = useState<User | null>(null)
  const [overview, setOverview] = useState<Overview | null>(null)
  const [activity, setActivity] = useState<ActivitySummary | null>(null)
  const [insights, setInsights] = useState<DashboardInsights | null>(null)
  const [repoActivity, setRepoActivity] = useState<ActivitySummary | null>(null)
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null)
  const [repoSummary, setRepoSummary] = useState<RepoSummary | null>(null)
  const [prCycle, setPrCycle] = useState<PrCycleTrend | null>(null)
  const [reviewLatency, setReviewLatency] = useState<ReviewLatency | null>(null)
  const [repoSort, setRepoSort] = useState<RepoSort>('recent')
  const [repoProviderFilter, setRepoProviderFilter] = useState<RepoProviderFilter>('all')
  const [repoSyncFilter, setRepoSyncFilter] = useState<RepoSyncFilter>('all')
  const [repoSearch, setRepoSearch] = useState('')
  const [rangeDays, setRangeDays] = useState<RangeDays>(365)
  const [analyticsScope, setAnalyticsScope] = useState<AnalyticsScope>('mine')
  const [state, setState] = useState<LoadState>('idle')
  const [syncing, setSyncing] = useState(false)
  const [syncingRepoId, setSyncingRepoId] = useState<string | null>(null)
  const [removingRepoId, setRemovingRepoId] = useState<string | null>(null)
  const [managerOpen, setManagerOpen] = useState(false)
  const [managerRepos, setManagerRepos] = useState<ManagerRepo[]>([])
  const [managerLoading, setManagerLoading] = useState(false)
  const [managerQuery, setManagerQuery] = useState('')
  const [accountMenuOpen, setAccountMenuOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [unlinkingProvider, setUnlinkingProvider] = useState<'github' | 'gitea' | null>(null)
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const refreshDashboard = async () => {
    const [nextOverview, nextActivity, nextInsights] = await Promise.all([
      api<Overview>(`/github/overview?scope=${analyticsScope}`),
      api<ActivitySummary>(`/github/activity?days=${rangeDays}&scope=${analyticsScope}`),
      api<DashboardInsights>(`/github/insights?days=${rangeDays}&scope=${analyticsScope}`),
    ])
    setOverview(nextOverview)
    setActivity(nextActivity)
    setInsights(nextInsights)
    return { nextOverview, nextActivity, nextInsights }
  }

  const load = async () => {
    setState('loading')
    try {
      const me = await api<{ user: User }>('/auth/me')
      setUser(me.user)

      await Promise.all([api('/github/repos'), api('/gitea/repos').catch(() => null)])
      const { nextOverview } = await refreshDashboard()
      setSelectedRepoId((current) => current ?? nextOverview.repos.find((repo) => repo.lastSyncedAt)?.id ?? null)
      setState('ready')
    } catch {
      setUser(null)
      setOverview(null)
      setActivity(null)
      setInsights(null)
      setRepoActivity(null)
      setPrCycle(null)
      setReviewLatency(null)
      setSelectedRepoId(null)
      setRepoSummary(null)
      setState('error')
    }
  }

  useEffect(() => {
    void load()
  }, [rangeDays, analyticsScope])

  const topRepos = useMemo(() => {
    return [...(overview?.repos ?? [])].sort((a, b) => b.commits - a.commits).slice(0, 5)
  }, [overview])

  const sortedRepos = useMemo(() => {
    const query = repoSearch.trim().toLowerCase()
    const repos = [...(overview?.repos ?? [])].filter((repo) => {
      const matchesProvider = repoProviderFilter === 'all' || repo.provider === repoProviderFilter
      const matchesSync = matchesSyncFilter(repo, repoSyncFilter)
      const matchesSearch = !query || repo.fullName.toLowerCase().includes(query)
      return matchesProvider && matchesSync && matchesSearch
    })
    if (repoSort === 'commits') {
      return repos.sort((a, b) => b.commits - a.commits)
    }
    if (repoSort === 'unsynced') {
      return repos.sort((a, b) => {
        if (!a.lastSyncedAt && b.lastSyncedAt) return -1
        if (a.lastSyncedAt && !b.lastSyncedAt) return 1
        return a.fullName.localeCompare(b.fullName)
      })
    }
    return repos.sort((a, b) => {
      if (!a.lastSyncedAt && !b.lastSyncedAt) return a.fullName.localeCompare(b.fullName)
      if (!a.lastSyncedAt) return 1
      if (!b.lastSyncedAt) return -1
      return new Date(b.lastSyncedAt).getTime() - new Date(a.lastSyncedAt).getTime()
    })
  }, [overview, repoProviderFilter, repoSearch, repoSort, repoSyncFilter])

  const selectedRepo = useMemo(() => {
    return overview?.repos.find((repo) => repo.id === selectedRepoId) ?? null
  }, [overview, selectedRepoId])

  const filteredManagerRepos = useMemo(() => {
    const query = managerQuery.trim().toLowerCase()
    if (!query) return managerRepos
    return managerRepos.filter((repo) => repo.fullName.toLowerCase().includes(query) || repo.provider.includes(query))
  }, [managerQuery, managerRepos])

  const managerStatusCounts = useMemo(() => {
    return managerRepos.reduce(
      (summary, repo) => {
        summary[repo.syncStatus] += 1
        return summary
      },
      {
        healthy: 0,
        queued: 0,
        syncing: 0,
        failed: 0,
        idle: 0,
      } satisfies Record<'healthy' | 'queued' | 'syncing' | 'failed' | 'idle', number>,
    )
  }, [managerRepos])

  useEffect(() => {
    if (!selectedRepoId) {
      setRepoSummary(null)
      setRepoActivity(null)
      setPrCycle(null)
      setReviewLatency(null)
      return
    }

    void Promise.all([
      api<RepoSummary>(`/github/repos/${selectedRepoId}/summary?scope=${analyticsScope}`),
      api<ActivitySummary>(`/github/activity?repoId=${selectedRepoId}&days=${rangeDays}&scope=${analyticsScope}`),
      api<PrCycleTrend>(`/github/repos/${selectedRepoId}/pr-cycle?days=${rangeDays}&scope=${analyticsScope}`),
      api<ReviewLatency>(`/github/repos/${selectedRepoId}/review-latency?days=${rangeDays}&scope=${analyticsScope}`),
    ])
      .then(([nextSummary, nextActivity, nextPrCycle, nextReviewLatency]) => {
        setRepoSummary(nextSummary)
        setRepoActivity(nextActivity)
        setPrCycle(nextPrCycle)
        setReviewLatency(nextReviewLatency)
      })
      .catch(() => {
        setRepoSummary(null)
        setRepoActivity(null)
        setPrCycle(null)
        setReviewLatency(null)
      })
  }, [selectedRepoId, rangeDays, analyticsScope])

  const connectGitHub = () => {
    window.location.href = `${API_URL}/auth/github`
  }

  const syncAll = async () => {
    setSyncing(true)
    setNotice(null)
    try {
      const [githubResult, giteaResult] = await Promise.all([
        api<{ queued: number; queueDepth: number }>('/github/repos/sync-all/background', {
          method: 'POST',
        }).catch(() => ({ queued: 0, queueDepth: 0 })),
        api<{ queued: number; queueDepth: number }>('/gitea/repos/sync-all/background', {
          method: 'POST',
        }).catch(() => ({ queued: 0, queueDepth: 0 })),
      ])
      const { nextInsights } = await refreshDashboard()
      const queued = githubResult.queued + giteaResult.queued
      const queueDepth = Math.max(githubResult.queueDepth, giteaResult.queueDepth, nextInsights.queueDepth)
      setNotice(getQueueNotice(queued, queueDepth))
    } catch (error) {
      setNotice(`Sync refresh failed: ${errorMessage(error)}`)
    } finally {
      setSyncing(false)
    }
  }

  const syncRepo = async (repoId: string) => {
    const repo = overview?.repos.find((candidate) => candidate.id === repoId)
    setSyncingRepoId(repoId)
    setNotice(null)
    try {
      const result = await api<{ queued: number; queueDepth: number }>(
        `/${repo?.provider ?? 'github'}/repos/${repoId}/sync/background`,
        { method: 'POST' },
      )
      await refreshDashboard()
      if (managerOpen) {
        await loadManagerRepos()
      }
      setSelectedRepoId(repoId)
      setNotice(getQueueNotice(result.queued, result.queueDepth, repo?.fullName ?? 'repository'))
    } catch (error) {
      setNotice(`Could not sync ${repo?.provider ?? 'repository'} ${repo?.fullName ?? repoId}: ${errorMessage(error)}`)
    } finally {
      setSyncingRepoId(null)
    }
  }

  const loadManagerRepos = async () => {
    setManagerLoading(true)
    try {
      const response = await api<{ repos: ManagerRepo[] }>(`/github/repos/manage?scope=${analyticsScope}`)
      setManagerRepos(response.repos)
    } finally {
      setManagerLoading(false)
    }
  }

  const openManager = () => {
    setManagerOpen(true)
    void loadManagerRepos()
  }

  const setRepoVisibility = async (repoId: string, isHidden: boolean) => {
    const repo = managerRepos.find((candidate) => candidate.id === repoId)
    if (!repo) return
    const previousManagerRepos = managerRepos

    setRemovingRepoId(repoId)
    setNotice(null)
    setManagerRepos((repos) =>
      repos.map((candidate) => (candidate.id === repoId ? { ...candidate, isHidden } : candidate)),
    )
    try {
      await api(`/github/repos/${repoId}/visibility`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isHidden }),
      })
      const [{ nextOverview }] = await Promise.all([
        refreshDashboard(),
        loadManagerRepos(),
      ])

      if (isHidden && selectedRepoId === repoId) {
        const nextSelected = nextOverview.repos.find((candidate) => candidate.lastSyncedAt)?.id ?? nextOverview.repos[0]?.id ?? null
        setSelectedRepoId(nextSelected)
      }

      setNotice(`${isHidden ? 'Hid' : 'Restored'} ${repo.fullName}.`)
    } catch (error) {
      setManagerRepos(previousManagerRepos)
      setNotice(error instanceof Error ? error.message : 'Could not update repo visibility.')
    } finally {
      setRemovingRepoId(null)
    }
  }

  const closeManager = () => {
    setManagerOpen(false)
    setManagerQuery('')
  }

  const openSettings = () => {
    setAccountMenuOpen(false)
    setSettingsOpen(true)
    void api<SystemStatus>('/auth/system')
      .then(setSystemStatus)
      .catch(() => setSystemStatus(null))
  }

  const closeSettings = () => {
    setSettingsOpen(false)
  }

  const unlinkProvider = async (provider: 'github' | 'gitea') => {
    setUnlinkingProvider(provider)
    setNotice(null)
    try {
      await api(`/auth/unlink/${provider}`, { method: 'POST' })
      const me = await api<{ user: User }>('/auth/me')
      setUser(me.user)
      setNotice(`${provider} disconnected.`)
    } catch (error) {
      setNotice(`Could not disconnect ${provider}: ${errorMessage(error)}`)
    } finally {
      setUnlinkingProvider(null)
    }
  }

  const logout = async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => null)
    setUser(null)
    setOverview(null)
    setActivity(null)
    setRepoActivity(null)
    setPrCycle(null)
    setReviewLatency(null)
    setSelectedRepoId(null)
    setRepoSummary(null)
    setAccountMenuOpen(false)
    setSettingsOpen(false)
    setNotice(null)
  }

  const totals = overview?.totals ?? { repos: 0, syncedRepos: 0, commits: 0, pullRequests: 0 }
  const insightSummary = insights ?? {
    windowDays: rangeDays,
    activeRepos: 0,
    mergedPullRequests: 0,
    averagePrCycleHours: null,
    averageReviewLatencyHours: null,
    staleRepos: 0,
    queueDepth: 0,
  }
  const syncHealth = getSyncHealthSummary(insightSummary.queueDepth, insightSummary.staleRepos)
  const rangeLabel = rangeDays === 365 ? 'the last year' : `the last ${rangeDays} days`
  const scopeLabel = analyticsScope === 'mine' ? 'your activity' : 'all contributors'
  const isAuthenticated = Boolean(user)
  const queueActive =
    insightSummary.queueDepth > 0 ||
    (overview?.repos ?? []).some((repo) => repo.syncStatus === 'queued' || repo.syncStatus === 'syncing')
  const activeSyncCount = (overview?.repos ?? []).filter(
    (repo) => repo.syncStatus === 'queued' || repo.syncStatus === 'syncing',
  ).length

  useEffect(() => {
    if (!isAuthenticated || !queueActive) return

    const interval = window.setInterval(() => {
      void refreshDashboard()
        .then(() => {
          if (managerOpen) {
            return loadManagerRepos()
          }
        })
        .catch(() => undefined)
    }, 4000)

    return () => window.clearInterval(interval)
  }, [analyticsScope, isAuthenticated, managerOpen, queueActive, rangeDays])

  if (!isAuthenticated) {
    return <AuthLanding onConnectGitHub={connectGitHub} />
  }

  return (
    <main className="app-shell">
      <section className="workspace-shell">
        <div className="aurora aurora-a" />
        <div className="aurora aurora-b" />
        <nav className="topbar workspace-topbar">
          <div className="brand">
            <span className="brand-mark">
              <Activity size={18} />
            </span>
            <span>DevPulse</span>
          </div>
          <div className="topbar-actions">
            {queueActive ? (
              <div className="topbar-sync-indicator">
                <Loader2 className="spin" size={14} />
                <span>{activeSyncCount > 0 ? `${activeSyncCount} syncing` : `${insightSummary.queueDepth} queued`}</span>
              </div>
            ) : null}
            {user ? (
              <WorkspaceSessionMenu
                accountMenuOpen={accountMenuOpen}
                avatarUrl={user.avatarUrl}
                onLogout={logout}
                onOpenSettings={openSettings}
                onToggle={() => setAccountMenuOpen((open) => !open)}
                username={user.username}
              />
            ) : null}
          </div>
        </nav>

        <div className="workspace-hero">
          <div className="workspace-copy">
            <p className="eyebrow">Workspace</p>
            <h2>Engineering signal for {scopeLabel}</h2>
            <p className="hero-text">
              Track repository activity, sync commits and pull requests, and keep an eye on review
              speed, cycle time, and sync health in one place.
            </p>
            <div className="hero-actions">
              <button className="primary-button" onClick={syncAll} disabled={syncing}>
                {syncing ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
                Sync All Repos
              </button>
              <button className="secondary-button" onClick={() => void api('/gitea/repos').then(load)}>
                <GitBranch size={18} />
                Add Gitea
              </button>
              <button className="secondary-button" onClick={openManager}>
                <Settings2 size={18} />
                Manage Repos
              </button>
              <button className="secondary-button" onClick={load}>
                <RefreshCw size={18} />
                Refresh
              </button>
            </div>
            {notice ? <p className="notice">{notice}</p> : null}
          </div>

          <div className="glass-panel workspace-status-strip">
            <StatusTile label="Live Pulse" value={String(totals.commits)} detail={`${totals.syncedRepos} repositories synced`} />
            <StatusTile label="Active Repos" value={String(insightSummary.activeRepos)} detail={rangeLabel} />
            <StatusTile label="Sync Health" value={syncHealth.value} detail={syncHealth.detail} />
          </div>
        </div>
      </section>

      <section className="dashboard">
        <div className="metric-grid">
          <Metric title="Repos" value={totals.repos} icon={<GitBranch size={20} />} />
          <Metric title="Synced" value={totals.syncedRepos} icon={<CheckCircle2 size={20} />} />
          <Metric title="Commits" value={totals.commits} icon={<Activity size={20} />} />
          <Metric title="Pull Requests" value={totals.pullRequests} icon={<Flame size={20} />} />
        </div>

        <div className="metric-grid insight-metric-grid">
          <Metric title="Active Repos" value={insightSummary.activeRepos} icon={<GitBranch size={20} />} detail={rangeLabel} />
          <Metric title="Merged PRs" value={insightSummary.mergedPullRequests} icon={<CheckCircle2 size={20} />} detail={rangeLabel} />
          <Metric
            title="Avg PR Cycle"
            value={insightSummary.averagePrCycleHours == null ? 'No data' : `${insightSummary.averagePrCycleHours.toFixed(1)}h`}
            icon={<RefreshCw size={20} />}
            detail={scopeLabel}
          />
          <Metric
            title="First Review"
            value={insightSummary.averageReviewLatencyHours == null ? 'No data' : `${insightSummary.averageReviewLatencyHours.toFixed(1)}h`}
            icon={<ShieldCheck size={20} />}
            detail={`${insightSummary.staleRepos} stale repos`}
          />
        </div>

        <section className="glass-panel contribution-panel">
          <div className="section-title">
            <div>
              <p className="eyebrow">Commit Rhythm</p>
              <h2>{activity?.total ?? 0} contributions in {rangeLabel}</h2>
            </div>
            <div className="range-tools">
              <span className="subtle-label">{scopeLabel}</span>
              <div className="segmented-control compact-control" aria-label="Contribution scope">
                {(['mine', 'all'] as const).map((scope) => (
                  <button
                    className={analyticsScope === scope ? 'active' : ''}
                    key={scope}
                    onClick={() => setAnalyticsScope(scope)}
                  >
                    {scope === 'mine' ? 'Mine' : 'All'}
                  </button>
                ))}
              </div>
              <div className="segmented-control compact-control" aria-label="Dashboard date range">
                {([30, 90, 365] as const).map((days) => (
                  <button
                    className={rangeDays === days ? 'active' : ''}
                    key={days}
                    onClick={() => setRangeDays(days)}
                  >
                    {days === 365 ? '1y' : `${days}d`}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <ContributionGraph days={activity?.days ?? []} />
        </section>

        <div className="content-grid">
          <section className="glass-panel repo-panel">
            <div className="section-title">
              <div>
                <p className="eyebrow">Repository Index</p>
                <h2>Synced repositories</h2>
              </div>
              <div className="repo-tools">
                <div className="segmented-control" aria-label="Sort repositories">
                  <button className={repoSort === 'recent' ? 'active' : ''} onClick={() => setRepoSort('recent')}>
                    Recent
                  </button>
                  <button className={repoSort === 'commits' ? 'active' : ''} onClick={() => setRepoSort('commits')}>
                    Commits
                  </button>
                  <button className={repoSort === 'unsynced' ? 'active' : ''} onClick={() => setRepoSort('unsynced')}>
                    Unsynced
                  </button>
                </div>
                <button className="icon-button" onClick={syncAll} disabled={!user || syncing} title="Sync all repos">
                  {syncing ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
                </button>
              </div>
            </div>

            <div className="repo-filter-bar">
              <label className="manager-search repo-search">
                <Search size={18} />
                <input
                  value={repoSearch}
                  onChange={(event) => setRepoSearch(event.target.value)}
                  placeholder="Search repositories"
                />
              </label>
              <div className="filter-controls">
                <div className="segmented-control compact-control repo-filter-control" aria-label="Filter by provider">
                  {(['all', 'github', 'gitea'] as const).map((provider) => (
                    <button
                      className={repoProviderFilter === provider ? 'active' : ''}
                      key={provider}
                      onClick={() => setRepoProviderFilter(provider)}
                    >
                      {provider === 'all' ? 'All' : provider}
                    </button>
                  ))}
                </div>
                <div className="segmented-control compact-control repo-filter-control" aria-label="Filter by sync status">
                  {(['all', 'healthy', 'queued', 'syncing', 'failed', 'unsynced'] as const).map((syncStatus) => (
                    <button
                      className={repoSyncFilter === syncStatus ? 'active' : ''}
                      key={syncStatus}
                      onClick={() => setRepoSyncFilter(syncStatus)}
                    >
                      {syncStatus === 'all' ? 'Any' : syncStatus}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {state === 'loading' ? (
              <div className="empty-state">Loading DevPulse data...</div>
            ) : !user ? (
              <div className="empty-state">Connect GitHub to populate the dashboard.</div>
            ) : (
              <div className="repo-table">
                {sortedRepos.map((repo) => (
                  <button
                    className={`repo-row ${repo.id === selectedRepoId ? 'selected' : ''}`}
                    key={repo.id}
                    onClick={() => setSelectedRepoId(repo.id)}
                  >
                    <div>
                      <strong>{repo.fullName}</strong>
                      <span>{repo.provider} · {formatDate(repo.lastSyncedAt)}</span>
                      <div className="repo-row-meta">
                        <SyncStatusPill status={repo.syncStatus} />
                        <small>{formatSyncTimestamp(repo)}</small>
                        {repo.lastSyncError ? <em>{repo.lastSyncError}</em> : null}
                      </div>
                    </div>
                    <div className="repo-stats">
                      <span>{repo.commits} commits</span>
                      <span>{repo.pullRequests} PRs</span>
                      <span
                        className="mini-button"
                        onClick={(event) => {
                          event.stopPropagation()
                          void syncRepo(repo.id)
                        }}
                        title={`Sync ${repo.fullName}`}
                        role="button"
                        tabIndex={0}
                      >
                        {syncingRepoId === repo.id ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
                      </span>
                    </div>
                  </button>
                ))}
                {!sortedRepos.length ? (
                  <div className="empty-state small">No repositories match those filters.</div>
                ) : null}
              </div>
            )}
          </section>

          <aside className="glass-panel insight-panel">
            <div className="section-title compact">
              <div>
                <p className="eyebrow">Momentum</p>
                <h2>Most active</h2>
              </div>
              <ArrowUpRight size={20} />
            </div>
            <div className="rank-list">
              {topRepos.length ? (
                topRepos.map((repo, index) => (
                  <div className="rank-row" key={repo.id}>
                    <span>{index + 1}</span>
                    <div>
                      <strong>{repo.fullName.split('/')[1]}</strong>
                      <p>{repo.commits} commits</p>
                    </div>
                  </div>
                ))
              ) : (
                <div className="empty-state small">No synced repositories yet.</div>
              )}
            </div>
          </aside>
        </div>

        <section className="glass-panel detail-panel">
          <div className="section-title">
            <div>
              <p className="eyebrow">Repo Detail</p>
              <h2>{selectedRepo?.fullName ?? 'Select a repository'}</h2>
            </div>
            {selectedRepo ? (
              <button
                className="secondary-button"
                onClick={() => void syncRepo(selectedRepo.id)}
                disabled={syncingRepoId === selectedRepo.id}
              >
                {syncingRepoId === selectedRepo.id ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
                Sync Repo
              </button>
            ) : null}
          </div>

          {selectedRepo ? (
            <>
              <div className="detail-sync-strip">
                <div className="detail-sync-copy">
                  <span className="subtle-label">Sync status</span>
                  <strong>{getSyncStatusLabel(selectedRepo.syncStatus)}</strong>
                  <p>{formatSyncDetail(selectedRepo, repoSummary?.repo.lastSyncedAt)}</p>
                </div>
                <SyncStatusPill status={selectedRepo.syncStatus} />
              </div>
              <div className="detail-grid">
                <div>
                  <span>Last synced</span>
                  <strong>{formatDate(repoSummary?.repo.lastSyncedAt ?? selectedRepo.lastSyncedAt)}</strong>
                </div>
                <div>
                  <span>Commits</span>
                  <strong>{repoSummary?.metrics.commits ?? selectedRepo.commits}</strong>
                </div>
                <div>
                  <span>Pull requests</span>
                  <strong>{repoSummary?.metrics.pullRequests ?? selectedRepo.pullRequests}</strong>
                </div>
                <div>
                  <span>Merged PRs</span>
                  <strong>
                    {repoSummary?.metrics.mergedPullRequests ?? 0}
                  </strong>
                </div>
              </div>
            </>
          ) : (
            <div className="empty-state small">Click a repo row to inspect it.</div>
          )}

          {selectedRepo ? (
            <div className="mini-chart-block">
              <div>
                <span className="subtle-label">Commit trend</span>
                <strong>{repoActivity?.total ?? 0} commits</strong>
                <p>{rangeDays === 365 ? 'Across the last year' : `Across the last ${rangeDays} days`}</p>
              </div>
              <RepoActivityChart days={repoActivity?.days ?? []} />
            </div>
          ) : null}

          {selectedRepo ? (
            <div className="pr-trend-block">
              <div>
                <span className="subtle-label">PR cycle trend</span>
                <strong>{formatTrend(prCycle)}</strong>
                <p>{formatTrendDetail(prCycle)}</p>
                <div className="detail-stat-row">
                  <StatPill
                    label="Average"
                    value={prCycle?.averageHours == null ? 'No data' : `${prCycle.averageHours.toFixed(1)}h`}
                  />
                  <StatPill
                    label="Median"
                    value={prCycle?.weeks.length ? `${median(prCycle.weeks.map((week) => week.averageHours)).toFixed(1)}h` : 'No data'}
                  />
                </div>
              </div>
              <PrCycleChart trend={prCycle} />
            </div>
          ) : null}

          {selectedRepo ? (
            <div className="review-latency-block">
              <div>
                <span className="subtle-label">Review latency</span>
                <strong>{formatReviewLatency(reviewLatency)}</strong>
                <p>{formatReviewLatencyDetail(reviewLatency)}</p>
                <div className="detail-stat-row">
                  <StatPill
                    label="Reviewed PRs"
                    value={reviewLatency?.reviewedPullRequests != null ? String(reviewLatency.reviewedPullRequests) : '0'}
                  />
                  <StatPill
                    label="Median"
                    value={reviewLatency?.weeks.length ? `${median(reviewLatency.weeks.map((week) => week.averageHours)).toFixed(1)}h` : 'No data'}
                  />
                </div>
              </div>
              <ReviewLatencyChart latency={reviewLatency} />
            </div>
          ) : null}
        </section>
      </section>

      {managerOpen ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={closeManager}>
          <section className="glass-panel repo-manager" role="dialog" aria-modal="true" aria-label="Manage repositories" onMouseDown={(event) => event.stopPropagation()}>
            <div className="section-title">
              <div>
                <p className="eyebrow">Manage Repos</p>
                <h2>Choose what DevPulse tracks</h2>
              </div>
              <button className="icon-button" onClick={closeManager} title="Close manager">
                <X size={18} />
              </button>
            </div>

            <div className="manager-actions">
              <button className="primary-button" onClick={syncAll} disabled={syncing || !overview?.repos.length}>
                {syncing ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
                Sync All Visible
              </button>
              <span className="subtle-label">{managerRepos.filter((repo) => !repo.isHidden).length} visible · {managerRepos.filter((repo) => repo.isHidden).length} hidden</span>
            </div>

            <div className="manager-summary-strip">
              <StatPill label="Healthy" value={String(managerStatusCounts.healthy)} />
              <StatPill label="Queued" value={String(managerStatusCounts.queued)} />
              <StatPill label="Syncing" value={String(managerStatusCounts.syncing)} />
              <StatPill label="Failed" value={String(managerStatusCounts.failed)} />
            </div>

            <label className="manager-search">
              <Search size={18} />
              <input
                value={managerQuery}
                onChange={(event) => setManagerQuery(event.target.value)}
                placeholder="Search repos"
              />
            </label>

            <div className="manager-list">
              {managerLoading ? (
                <div className="empty-state">Loading repositories...</div>
              ) : filteredManagerRepos.length ? (
                filteredManagerRepos.map((repo) => (
                  <div className={`manager-row ${repo.isHidden ? 'is-hidden' : ''}`} key={repo.id}>
                    <div>
                      <strong>
                        <span className={`visibility-dot ${repo.isHidden ? 'off' : 'on'}`} />
                        {repo.fullName}
                      </strong>
                      <span>{repo.provider} · {formatDate(repo.lastSyncedAt)} · {repo.commits} commits · {repo.pullRequests} PRs</span>
                      <div className="repo-row-meta manager-meta">
                        <SyncStatusPill status={repo.syncStatus} />
                        <small>{formatSyncTimestamp(repo)}</small>
                        {repo.lastSyncError ? <em>{repo.lastSyncError}</em> : null}
                      </div>
                    </div>
                    <div className="manager-row-actions">
                      <button className="secondary-button compact-button" onClick={() => void syncRepo(repo.id)} disabled={repo.isHidden || syncingRepoId === repo.id || removingRepoId === repo.id}>
                        {syncingRepoId === repo.id ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
                        Sync
                      </button>
                      <button className={`${repo.isHidden ? 'secondary-button' : 'danger-button'} compact-button`} onClick={() => void setRepoVisibility(repo.id, !repo.isHidden)} disabled={removingRepoId === repo.id || syncingRepoId === repo.id}>
                        {removingRepoId === repo.id ? <Loader2 className="spin" size={16} /> : <Trash2 size={16} />}
                        {repo.isHidden ? 'Show' : 'Hide'}
                      </button>
                    </div>
                  </div>
                ))
              ) : (
                <div className="empty-state">{managerQuery ? 'No repos match that search.' : 'No visible repos to manage.'}</div>
              )}
            </div>
          </section>
        </div>
      ) : null}

      {settingsOpen && user ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={closeSettings}>
          <section className="glass-panel settings-panel" role="dialog" aria-modal="true" aria-label="Settings" onMouseDown={(event) => event.stopPropagation()}>
            <div className="section-title">
              <div>
                <p className="eyebrow">Settings</p>
                <h2>Account and connections</h2>
              </div>
              <button className="icon-button" onClick={closeSettings} title="Close settings">
                <X size={18} />
              </button>
            </div>

            <div className="settings-account">
              {user.avatarUrl ? <img src={user.avatarUrl} alt="" /> : <Github size={24} />}
              <div>
                <strong>{user.username}</strong>
                <span>{user.email}</span>
              </div>
            </div>

            <div className="settings-list">
              <ProviderSetting
                connected={user.githubConnected}
                detail={user.githubConnected ? `Connected as ${user.username}` : 'Disconnected. Reconnect with GitHub OAuth.'}
                icon={<Github size={30} />}
                isBusy={unlinkingProvider === 'github'}
                name="GitHub"
                onConnect={connectGitHub}
                onUnlink={() => void unlinkProvider('github')}
              />
              <ProviderSetting
                connected={user.giteaConnected}
                detail={user.giteaConnected ? `Connected as ${user.giteaUsername}` : 'Disconnected. Gitea uses your local env token.'}
                icon={<GitBranch size={20} />}
                isBusy={unlinkingProvider === 'gitea'}
                name="Gitea"
                onConnect={() => void api('/gitea/repos').then(load).catch((error) => setNotice(`Could not connect gitea: ${errorMessage(error)}`))}
                onUnlink={() => void unlinkProvider('gitea')}
              />
            </div>

            <div className="settings-system">
              <p className="eyebrow">Infrastructure</p>
              {systemStatus ? (
                <div className="settings-system-grid">
                  <StatPill label="API" value={systemStatus.api.status.toUpperCase()} />
                  <StatPill label="Mode" value={systemStatus.api.nodeEnv} />
                  <StatPill label="Sync cadence" value={formatInterval(systemStatus.sync.intervalSeconds)} />
                  <StatPill label="Run on start" value={systemStatus.sync.runOnStart ? 'Enabled' : 'Off'} />
                  <StatPill label="Queue depth" value={String(systemStatus.sync.queueDepth)} />
                  <StatPill label="GitHub OAuth" value={systemStatus.providers.githubOauthConfigured ? 'Ready' : 'Missing'} />
                  <StatPill label="Gitea env" value={systemStatus.providers.giteaConfigured ? 'Ready' : 'Missing'} />
                </div>
              ) : (
                <div className="empty-state small">System status is unavailable right now.</div>
              )}
            </div>

            <div className="settings-footer">
              <button className="secondary-button" onClick={logout}>
                <LogOut size={18} />
                Log out
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  )
}

const formatTrend = (trend: PrCycleTrend | null) => {
  if (!trend || trend.averageHours == null) return 'No merged PRs'
  if (trend.trend === 'improving') return 'Improving'
  if (trend.trend === 'slowing') return 'Slowing'
  return 'Steady'
}

const formatTrendDetail = (trend: PrCycleTrend | null) => {
  if (!trend || trend.averageHours == null) return 'Sync a repo with merged PRs to see cycle trends.'
  const average = `${trend.averageHours.toFixed(1)}h average`
  if (trend.deltaHours == null) return average
  const direction = trend.deltaHours > 0 ? 'slower' : 'faster'
  return `${average}, ${Math.abs(trend.deltaHours).toFixed(1)}h ${direction} vs earlier weeks`
}

const formatReviewLatency = (latency: ReviewLatency | null) => {
  if (!latency || latency.averageHours == null) return 'No review data'
  return `${latency.averageHours.toFixed(1)}h`
}

const formatReviewLatencyDetail = (latency: ReviewLatency | null) => {
  if (!latency || latency.averageHours == null) return 'Sync PR reviews to see first-review timing.'
  return `Average first review across ${latency.reviewedPullRequests} reviewed PRs`
}

function ReviewLatencyChart({ latency }: { latency: ReviewLatency | null }) {
  const weeks = latency?.weeks ?? []

  if (!weeks.length) {
    return <div className="trend-empty">No weekly review latency data yet.</div>
  }

  return (
    <TrendLineChart
      points={weeks.map((week) => ({
        key: week.week,
        label: formatWeekLabel(week.week),
        value: week.averageHours,
      }))}
      subtitle="First review response"
      tone="amber"
    />
  )
}

function PrCycleChart({ trend }: { trend: PrCycleTrend | null }) {
  const weeks = trend?.weeks ?? []

  if (!weeks.length) {
    return <div className="trend-empty">No weekly PR cycle data yet.</div>
  }

  return (
    <TrendLineChart
      points={weeks.map((week) => ({
        key: week.week,
        label: formatWeekLabel(week.week),
        value: week.averageHours,
      }))}
      subtitle={trend?.trend === 'improving' ? 'Moving faster' : trend?.trend === 'slowing' ? 'Taking longer' : 'Holding steady'}
      tone={trend?.trend === 'slowing' ? 'rose' : 'mint'}
    />
  )
}

function RepoActivityChart({ days }: { days: ActivityDay[] }) {
  const points = useMemo(() => bucketActivityDays(days), [days])

  return (
    <TrendLineChart
      points={points}
      subtitle="Commit volume"
      tone="mint"
      valueSuffix=""
    />
  )
}

function Metric({
  title,
  value,
  icon,
  detail,
}: {
  title: string
  value: number | string
  icon: React.ReactNode
  detail?: string
}) {
  return (
    <div className="glass-panel metric-card">
      <div className="metric-icon">{icon}</div>
      <span>{title}</span>
      <strong>{value}</strong>
      {detail ? <small>{detail}</small> : null}
    </div>
  )
}

function StatusTile({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="status-tile">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  )
}

function ProviderSetting({
  connected,
  detail,
  icon,
  isBusy,
  name,
  onConnect,
  onUnlink,
}: {
  connected: boolean
  detail: string
  icon: React.ReactNode
  isBusy: boolean
  name: string
  onConnect: () => void
  onUnlink: () => void
}) {
  return (
    <div className="settings-row">
      <div className="settings-provider">
        <span className="settings-icon">{icon}</span>
        <div>
          <strong>{name}</strong>
          <span>{detail}</span>
        </div>
      </div>
      <div className="settings-row-actions">
        <span className={`connection-pill ${connected ? 'connected' : 'disconnected'}`}>
          {connected ? 'Connected' : 'Disconnected'}
        </span>
        {connected ? (
          <button className="danger-button compact-button" onClick={onUnlink} disabled={isBusy}>
            {isBusy ? <Loader2 className="spin" size={16} /> : <Link2Off size={16} />}
            Unlink
          </button>
        ) : (
          <button className="secondary-button compact-button" onClick={onConnect}>
            Connect
          </button>
        )}
      </div>
    </div>
  )
}

function StatPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="detail-stat-pill">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function SyncStatusPill({
  status,
}: {
  status: 'idle' | 'queued' | 'syncing' | 'healthy' | 'failed' | undefined
}) {
  const resolvedStatus = status ?? 'healthy'
  return (
    <span className={`sync-status-pill ${resolvedStatus}`}>
      <span className="sync-status-pill-label">{getSyncStatusLabel(resolvedStatus)}</span>
    </span>
  )
}

function TrendLineChart({
  points,
  subtitle,
  tone,
  valueSuffix = 'h',
}: {
  points: LinePoint[]
  subtitle: string
  tone: 'mint' | 'amber' | 'rose'
  valueSuffix?: string
}) {
  const [hoveredKey, setHoveredKey] = useState<string | null>(null)
  const width = 560
  const height = 116
  const paddingX = 12
  const paddingTop = 12
  const paddingBottom = 18
  const max = Math.max(...points.map((point) => point.value), 1)
  const min = Math.min(...points.map((point) => point.value), 0)
  const range = Math.max(max - min, 1)
  const step = points.length > 1 ? (width - paddingX * 2) / (points.length - 1) : 0

  const coords = points.map((point, index) => {
    const x = paddingX + index * step
    const y =
      height -
      paddingBottom -
      ((point.value - min) / range) * (height - paddingTop - paddingBottom)
    return { ...point, x, y }
  })

  const line = coords.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ')
  const area = `${line} L ${coords[coords.length - 1]?.x ?? paddingX} ${height - paddingBottom} L ${coords[0]?.x ?? paddingX} ${height - paddingBottom} Z`
  const tickIndexes = Array.from(new Set([0, Math.floor((coords.length - 1) / 2), coords.length - 1])).filter((index) => index >= 0)
  const yTicks = [
    { label: `${max.toFixed(max >= 10 ? 0 : 1)}${valueSuffix}`, position: paddingTop },
    { label: `${(min + range / 2).toFixed(range / 2 >= 10 ? 0 : 1)}${valueSuffix}`, position: (height - paddingBottom + paddingTop) / 2 },
    { label: `${min.toFixed(min >= 10 ? 0 : 1)}${valueSuffix}`, position: height - paddingBottom },
  ]

  const updateHoveredPoint = (clientX: number, currentTarget: EventTarget & SVGSVGElement) => {
    const bounds = currentTarget.getBoundingClientRect()
    const relativeX = ((clientX - bounds.left) / bounds.width) * width
    const nextPoint = coords.reduce((closest, point) =>
      Math.abs(point.x - relativeX) < Math.abs(closest.x - relativeX) ? point : closest,
    )
    setHoveredKey(nextPoint.key)
  }

  return (
    <div className={`trend-chart-shell tone-${tone}`}>
      <div className="trend-chart-header">
        <span>{subtitle}</span>
        <span>{max.toFixed(max >= 10 ? 0 : 1)}{valueSuffix} max</span>
      </div>
      <div className="trend-chart-layout">
        <div className="trend-y-axis" aria-hidden="true">
          {yTicks.map((tick) => (
            <span key={`${tick.label}-${tick.position}`} style={{ top: `${(tick.position / height) * 100}%` }}>
              {tick.label}
            </span>
          ))}
        </div>
        <div className="trend-chart-main">
          <svg
            className="trend-line-chart"
            viewBox={`0 0 ${width} ${height}`}
            aria-label={subtitle}
            onMouseMove={(event) => updateHoveredPoint(event.clientX, event.currentTarget)}
            onMouseLeave={() => setHoveredKey(null)}
          >
            <path className="trend-grid-line" d={`M ${paddingX} ${height - paddingBottom} H ${width - paddingX}`} />
            <path className="trend-grid-line faint" d={`M ${paddingX} ${(height - paddingBottom + paddingTop) / 2} H ${width - paddingX}`} />
            <path className="trend-area" d={area} />
            <path className="trend-line" d={line} />
            {coords.map((point) => (
              <circle
                className={`trend-point ${hoveredKey === point.key ? 'active' : ''}`}
                cx={point.x}
                cy={point.y}
                key={point.key}
                r={hoveredKey === point.key ? '5' : '3.5'}
              />
            ))}
          </svg>
        </div>
      </div>
      <div className="trend-chart-labels">
        {tickIndexes.map((index) => (
          <span key={coords[index]?.key}>{coords[index]?.label}</span>
        ))}
      </div>
    </div>
  )
}

const median = (values: number[]) => {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const midpoint = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) {
    return (sorted[midpoint - 1] + sorted[midpoint]) / 2
  }
  return sorted[midpoint]
}

const formatWeekLabel = (value: string) => {
  const date = new Date(`${value}T00:00:00`)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date)
}

const bucketActivityDays = (days: ActivityDay[]) => {
  const sourceDays = days.length
    ? days
    : (() => {
        const fallback: ActivityDay[] = []
        const end = new Date()
        const start = new Date(end)
        start.setDate(start.getDate() - 29)
        for (let cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
          fallback.push({ date: cursor.toISOString().slice(0, 10), count: 0 })
        }
        return fallback
      })()

  if (sourceDays.length <= 24) {
    return sourceDays.map((day) => ({
      key: day.date,
      label: formatWeekLabel(day.date),
      value: day.count,
    }))
  }

  const bucketSize = Math.ceil(sourceDays.length / 24)
  const buckets: LinePoint[] = []
  for (let index = 0; index < sourceDays.length; index += bucketSize) {
    const bucketDays = sourceDays.slice(index, index + bucketSize)
    const first = bucketDays[0]
    const last = bucketDays[bucketDays.length - 1]
    buckets.push({
      key: `${first.date}-${last.date}`,
      label: first.date === last.date ? formatWeekLabel(first.date) : `${formatWeekLabel(first.date)} - ${formatWeekLabel(last.date)}`,
      value: bucketDays.reduce((total, day) => total + day.count, 0),
    })
  }
  return buckets
}

const formatInterval = (seconds: number) => {
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`
  const days = seconds / 86400
  return Number.isInteger(days) ? `${days}d` : `${days.toFixed(1)}d`
}

function ContributionGraph({ days }: { days: ActivityDay[] }) {
  const [hoveredDay, setHoveredDay] = useState<ActivityDay | null>(null)
  const normalizedDays = useMemo(() => {
    if (days.length) return days

    const fallback: ActivityDay[] = []
    const end = new Date()
    const start = new Date(end)
    start.setDate(start.getDate() - 364)
    for (let cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
      fallback.push({ date: cursor.toISOString().slice(0, 10), count: 0 })
    }
    return fallback
  }, [days])

  const weeks = useMemo(() => {
    const padded: Array<ActivityDay | null> = []
    const first = new Date(`${normalizedDays[0]?.date}T00:00:00`)
    const leading = Number.isNaN(first.getTime()) ? 0 : first.getDay()

    for (let index = 0; index < leading; index += 1) {
      padded.push(null)
    }
    padded.push(...normalizedDays)

    const nextWeeks: Array<Array<ActivityDay | null>> = []
    for (let index = 0; index < padded.length; index += 7) {
      nextWeeks.push(padded.slice(index, index + 7))
    }
    return nextWeeks
  }, [normalizedDays])

  const max = Math.max(...normalizedDays.map((day) => day.count), 1)

  const levelFor = (count: number) => {
    if (count === 0) return 0
    if (count <= Math.ceil(max * 0.25)) return 1
    if (count <= Math.ceil(max * 0.5)) return 2
    if (count <= Math.ceil(max * 0.75)) return 3
    return 4
  }

  const monthLabels = useMemo(() => {
    const labels: Array<{ month: string; week: number }> = []
    let previous = ''
    weeks.forEach((week, weekIndex) => {
      const firstDay = week.find(Boolean)
      if (!firstDay) return

      const month = new Intl.DateTimeFormat(undefined, { month: 'short' }).format(
        new Date(`${firstDay.date}T00:00:00`),
      )
      if (month !== previous) {
        labels.push({ month, week: weekIndex })
        previous = month
      }
    })
    return labels
  }, [weeks])

  return (
    <div className="contribution-shell">
      <div className={`commit-tooltip ${hoveredDay ? 'visible' : ''}`}>
        {hoveredDay ? (
          <>
            <strong>{hoveredDay.count}</strong>
            <span>{hoveredDay.count === 1 ? 'commit' : 'commits'}</span>
            <small>
              {new Intl.DateTimeFormat(undefined, {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              }).format(new Date(`${hoveredDay.date}T00:00:00`))}
            </small>
          </>
        ) : null}
      </div>
      <div className="month-row">
        {monthLabels.map((label) => (
          <span key={`${label.month}-${label.week}`} style={{ gridColumnStart: label.week + 1 }}>
            {label.month}
          </span>
        ))}
      </div>
      <div className="heatmap-wrap">
        <div className="weekday-labels">
          <span>Mon</span>
          <span>Wed</span>
          <span>Fri</span>
        </div>
        <div className="heatmap-grid">
          {weeks.map((week, weekIndex) => (
            <div className="heatmap-week" key={weekIndex}>
              {Array.from({ length: 7 }).map((_, dayIndex) => {
                const day = week[dayIndex]
                return day ? (
                  <span
                    className={`heatmap-cell level-${levelFor(day.count)}`}
                    key={day.date}
                    onBlur={() => setHoveredDay(null)}
                    onFocus={() => setHoveredDay(day)}
                    onMouseEnter={() => setHoveredDay(day)}
                    onMouseLeave={() => setHoveredDay(null)}
                    tabIndex={0}
                  />
                ) : (
                  <span className="heatmap-cell empty" key={`empty-${weekIndex}-${dayIndex}`} />
                )
              })}
            </div>
          ))}
        </div>
      </div>
      <div className="heatmap-legend">
        <span>Less</span>
        {[0, 1, 2, 3, 4].map((level) => (
          <i className={`heatmap-cell level-${level}`} key={level} />
        ))}
        <span>More</span>
      </div>
    </div>
  )
}
