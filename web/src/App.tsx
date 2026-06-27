import { useEffect, useMemo, useState } from 'react'
import {
  Activity,
  ArrowLeft,
  BrainCircuit,
  CheckCircle2,
  Clock3,
  ChevronDown,
  ChevronRight,
  Eye,
  GitBranch,
  Github,
  Link2Off,
  Loader2,
  LogOut,
  Search,
  Settings2,
  Sparkles,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Users,
  X,
} from 'lucide-react'
import { AuthLanding } from './components/AuthLanding'
import { WorkspaceSessionMenu } from './components/WorkspaceSessionMenu'
import {
  compareToWorkspaceAverage,
  filterManagerRepos,
  getQueueNotice,
  getSyncHealthSummary,
  getSyncStatusLabel,
  matchesSyncFilter,
  summarizeManagerRepos,
} from './lib/dashboard-utils.js'

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000'
const SESSION_STORAGE_KEY = 'devpulse:session'

const readSessionToken = () => localStorage.getItem(SESSION_STORAGE_KEY)

const consumeRedirectSession = () => {
  const url = new URL(window.location.href)
  const session = url.searchParams.get('session')
  if (!session) {
    const connected = url.searchParams.get('connected')
    const bridgeAttempted = url.searchParams.get('authBridge') === '1'

    if (connected && !bridgeAttempted) {
      url.searchParams.set('authBridge', '1')
      window.location.href = `${API_URL}/auth/session?returnTo=${encodeURIComponent(url.toString())}`
      return true
    }

    return false
  }

  localStorage.setItem(SESSION_STORAGE_KEY, session)
  url.searchParams.delete('session')
  url.searchParams.delete('authBridge')
  window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)
  return false
}

const authRedirectMessage = (error: string, tier: string | null) => {
  const tierLabel = tier === 'full' ? 'Full' : tier === 'standard' ? 'Standard' : 'GitHub'
  if (error === 'github-app-slug-missing') {
    return `${tierLabel} GitHub App setup is missing its app slug on the server, so DevPulse cannot open GitHub's repository selection page yet.`
  }
  if (error === 'github-installation-mismatch') {
    return `${tierLabel} GitHub App installation does not match this DevPulse connection. Reinstall the matching GitHub App and select repositories.`
  }
  if (error === 'github-installation-token-failed') {
    return `${tierLabel} GitHub App installation could not be verified. Try the setup flow again and select repositories on GitHub.`
  }
  return `GitHub setup failed: ${error}`
}

const authSetupMessage = (setup: string, tier: string | null) => {
  const tierLabel = tier === 'full' ? 'Full' : tier === 'standard' ? 'Standard' : 'GitHub'
  if (setup === 'github-install-required') {
    return `${tierLabel} GitHub authorization worked, but no repositories were selected yet. Finish setup to choose repos on GitHub.`
  }
  return `${tierLabel} setup still needs attention.`
}

type User = {
  id: string
  githubId: string
  username: string
  giteaUsername: string | null
  giteaBaseUrl: string | null
  email: string
  avatarUrl: string | null
  githubConnected: boolean
  githubAppInstalled?: boolean
  accessTier?: 'standard' | 'full'
  githubAppKind?: 'standard' | 'full' | null
  githubTiers?: {
    standard: { authorized: boolean; installed: boolean }
    full: { authorized: boolean; installed: boolean }
  }
  giteaConnected: boolean
}

type ConnectionStatus = 'connected' | 'authorized' | 'disconnected'

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
    lastSyncStartedAt: string | null
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

type TeamSummary = { id: string; name: string; slug: string; role: string; members: number; repositories: number }
type TeamDashboard = {
  team: { id: string; name: string; slug: string; role: string }
  totals: { repositories: number; commits: number; pullRequests: number; mergedPullRequests: number; reviews: number }
  repositories: Array<{ id: string; provider: string; fullName: string; commits: number; pullRequests: number; lastSyncedAt: string | null }>
  members: Array<{ id: string; username: string; avatarUrl: string | null; role: string; commits: number; pullRequests: number }>
  analytics: {
    days: number | null
    repoId: string | null
    memberId: string | null
    totals: { repositories: number; commits: number; pullRequests: number; mergedPullRequests: number; reviews: number }
    activity: Array<{ date: string; commits: number; pullRequests: number; reviews: number }>
  }
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
  detail?: string
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
    lastSyncStartedAt?: string | null
    lastSyncFinishedAt?: string | null
    syncStatus?: 'idle' | 'queued' | 'syncing' | 'healthy' | 'failed'
    lastSyncError?: string | null
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

type PrPredictions = {
  predictions: Array<{
    pullRequest: { number: number; title: string; openedAt: string }
    predictedHours: number
    lowerBoundHours: number | null
    upperBoundHours: number | null
    modelVersion: string
    modelKind: 'random_forest' | 'median_baseline'
    predictedAt: string
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
    status: 'healthy' | 'degraded'
    repos: {
      total: number
      queued: number
      syncing: number
      healthy: number
      failed: number
      idle: number
    }
    recentFailures: Array<{
      id: string
      fullName: string
      provider: string
      lastSyncError: string
      lastSyncFinishedAt: string | null
    }>
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
  recommendations?: Array<{
    id: string
    severity: 'critical' | 'warning' | 'opportunity' | 'positive'
    title: string
    detail: string
    actionLabel: string
    actionKind: 'sync' | 'inspect' | 'none'
    repoId?: string
    repoFullName?: string
    impact: 'high' | 'medium' | 'low'
    evidence: string
    metric?: {
      key: string
      label: string
      value: number
      better: 'higher' | 'lower'
    }
  }>
}

type RecommendationMemory = Record<string, {
  dismissedAt?: string
  snoozedUntil?: string
  baseline?: number
  latest?: number
  better?: 'higher' | 'lower'
}>

type LoadState = 'idle' | 'loading' | 'ready' | 'error'
type RepoSort = 'recent' | 'commits'
type RangeDays = 30 | 90 | 365 | 'all'
type AnalyticsScope = 'mine' | 'all'
type RepoProviderFilter = 'all' | 'github' | 'gitea'
type RepoSyncFilter = 'all' | 'healthy' | 'queued' | 'syncing' | 'failed' | 'unsynced'
type NoticeTone = 'info' | 'success' | 'error'
type NoticeState = { message: string; tone: NoticeTone } | null

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
  const session = readSessionToken()
  const headers = new Headers(init?.headers)
  if (session && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${session}`)
  }

  const response = await fetch(`${API_URL}${path}`, {
    credentials: 'include',
    ...init,
    headers,
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
  if (repo.syncStatus === 'failed') {
    if (repo.lastSyncFinishedAt) return `Failed ${formatDate(repo.lastSyncFinishedAt)}. ${repo.lastSyncError ?? ''}`.trim()
    return repo.lastSyncError ?? 'Last sync attempt failed.'
  }
  if (repo.syncStatus === 'queued') return 'Queued for background sync.'
  if (repo.syncStatus === 'syncing') {
    return repo.lastSyncStartedAt ? `Background sync started ${formatDate(repo.lastSyncStartedAt)}.` : 'Background sync is running now.'
  }

  const finishedAt = repo.lastSyncFinishedAt ?? fallbackLastSyncedAt ?? repo.lastSyncedAt
  return finishedAt ? `Finished ${formatDate(finishedAt)}.` : 'No sync history yet.'
}

const formatSyncTimestamp = (repo: Overview['repos'][number]) => {
  if (repo.syncStatus === 'syncing' && repo.lastSyncStartedAt) return `Started ${formatDate(repo.lastSyncStartedAt)}`
  if (repo.syncStatus === 'failed' && repo.lastSyncFinishedAt) return `Failed ${formatDate(repo.lastSyncFinishedAt)}`
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
  const [prPredictions, setPrPredictions] = useState<PrPredictions | null>(null)
  const [predictionsOpen, setPredictionsOpen] = useState(false)
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
  const [restoringRepos, setRestoringRepos] = useState(false)
  const [managerQuery, setManagerQuery] = useState('')
  const [managerSyncFilter, setManagerSyncFilter] = useState<'all' | 'healthy' | 'queued' | 'syncing' | 'failed'>(
    'all',
  )
  const [managerVisibilityFilter, setManagerVisibilityFilter] = useState<'all' | 'visible' | 'hidden'>('all')
  const [accountMenuOpen, setAccountMenuOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [teamPanelOpen, setTeamPanelOpen] = useState(() => window.location.pathname === '/team')
  const [teams, setTeams] = useState<TeamSummary[]>([])
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null)
  const [teamDashboard, setTeamDashboard] = useState<TeamDashboard | null>(null)
  const [teamRepoIds, setTeamRepoIds] = useState<string[]>([])
  const [teamRangeDays, setTeamRangeDays] = useState<RangeDays>(90)
  const [teamRepoFilter, setTeamRepoFilter] = useState('all')
  const [teamMemberFilter, setTeamMemberFilter] = useState('all')
  const [teamName, setTeamName] = useState('')
  const [teamMemberUsername, setTeamMemberUsername] = useState('')
  const [teamBusy, setTeamBusy] = useState(false)
  const [teamPageInitialized, setTeamPageInitialized] = useState(false)
  const [teamFeedback, setTeamFeedback] = useState<NoticeState>(null)
  const [teamDeleteOpen, setTeamDeleteOpen] = useState(false)
  const [teamDeleteConfirmation, setTeamDeleteConfirmation] = useState('')
  const [unlinkingProvider, setUnlinkingProvider] = useState<'github' | 'gitea' | null>(null)
  const [connectingProvider, setConnectingProvider] = useState<'gitea' | null>(null)
  const [giteaFormOpen, setGiteaFormOpen] = useState(false)
  const [giteaBaseUrl, setGiteaBaseUrl] = useState('')
  const [giteaToken, setGiteaToken] = useState('')
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null)
  const [notice, setNotice] = useState<NoticeState>(null)
  const [recommendationMemory, setRecommendationMemory] = useState<RecommendationMemory>(() => {
    try {
      return JSON.parse(localStorage.getItem('devpulse:recommendations') ?? '{}') as RecommendationMemory
    } catch {
      return {}
    }
  })

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
      setGiteaBaseUrl(me.user.giteaBaseUrl ?? '')

      if (!me.user.githubConnected) {
        setOverview({
          totals: { repos: 0, syncedRepos: 0, commits: 0, pullRequests: 0 },
          repos: [],
        })
        setActivity({ total: 0, days: [] })
        setInsights({
          windowDays: rangeDays === 'all' ? 0 : rangeDays,
          activeRepos: 0,
          mergedPullRequests: 0,
          averagePrCycleHours: null,
          averageReviewLatencyHours: null,
          staleRepos: 0,
          queueDepth: 0,
          recommendations: [],
        })
        setSelectedRepoId(null)
        setState('ready')
        return
      }

      await Promise.all([
        api('/github/repos').catch((error) => {
          setNotice({ message: `Could not refresh GitHub repositories: ${errorMessage(error)}`, tone: 'error' })
          return null
        }),
        api('/gitea/repos').catch(() => null),
      ])

      const { nextOverview } = await refreshDashboard().catch(() => {
        const emptyOverview: Overview = {
          totals: { repos: 0, syncedRepos: 0, commits: 0, pullRequests: 0 },
          repos: [],
        }
        const emptyActivity: ActivitySummary = { total: 0, days: [] }
        const emptyInsights: DashboardInsights = {
          windowDays: rangeDays === 'all' ? 0 : rangeDays,
          activeRepos: 0,
          mergedPullRequests: 0,
          averagePrCycleHours: null,
          averageReviewLatencyHours: null,
          staleRepos: 0,
          queueDepth: 0,
          recommendations: [],
        }

        setOverview(emptyOverview)
        setActivity(emptyActivity)
        setInsights(emptyInsights)
        return { nextOverview: emptyOverview, nextActivity: emptyActivity, nextInsights: emptyInsights }
      })

      setSelectedRepoId((current) => current ?? nextOverview.repos.find((repo) => repo.lastSyncedAt)?.id ?? null)
      setState('ready')
    } catch (error) {
      localStorage.removeItem(SESSION_STORAGE_KEY)
      setNotice({ message: `Session check failed: ${errorMessage(error)}`, tone: 'error' })
      setUser(null)
      setOverview(null)
      setActivity(null)
      setInsights(null)
      setRepoActivity(null)
      setPrCycle(null)
      setReviewLatency(null)
      setPrPredictions(null)
      setSelectedRepoId(null)
      setRepoSummary(null)
      setState('error')
    }
  }

  useEffect(() => {
    if (consumeRedirectSession()) return

    const url = new URL(window.location.href)
    const setupError = url.searchParams.get('error')
    if (setupError) {
      setNotice({ message: authRedirectMessage(setupError, url.searchParams.get('tier')), tone: 'error' })
      url.searchParams.delete('error')
      url.searchParams.delete('tier')
      window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)
    }

    const setupState = url.searchParams.get('setup')
    if (setupState) {
      setNotice({ message: authSetupMessage(setupState, url.searchParams.get('authorized')), tone: 'info' })
      url.searchParams.delete('setup')
      url.searchParams.delete('authorized')
      window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)
    }

    void load()
  }, [rangeDays, analyticsScope])

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
    return filterManagerRepos(managerRepos, managerQuery, managerSyncFilter, managerVisibilityFilter)
  }, [managerQuery, managerRepos, managerSyncFilter, managerVisibilityFilter])

  const managerStatusCounts = useMemo(() => {
    return summarizeManagerRepos(managerRepos)
  }, [managerRepos])

  useEffect(() => {
    setPredictionsOpen(false)
    if (!selectedRepoId) {
      setRepoSummary(null)
      setRepoActivity(null)
      setPrCycle(null)
      setReviewLatency(null)
      return
    }

    void Promise.all([
      api<RepoSummary>(`/github/repos/${selectedRepoId}/summary?days=${rangeDays}&scope=${analyticsScope}`),
      api<ActivitySummary>(`/github/activity?repoId=${selectedRepoId}&days=${rangeDays}&scope=${analyticsScope}`),
      api<PrCycleTrend>(`/github/repos/${selectedRepoId}/pr-cycle?days=${rangeDays}&scope=${analyticsScope}`),
      api<ReviewLatency>(`/github/repos/${selectedRepoId}/review-latency?days=${rangeDays}&scope=${analyticsScope}`),
      api<PrPredictions>(`/github/repos/${selectedRepoId}/predictions`),
    ])
      .then(([nextSummary, nextActivity, nextPrCycle, nextReviewLatency, nextPredictions]) => {
        setRepoSummary(nextSummary)
        setRepoActivity(nextActivity)
        setPrCycle(nextPrCycle)
        setReviewLatency(nextReviewLatency)
        setPrPredictions(nextPredictions)
      })
      .catch(() => {
        setRepoSummary(null)
        setRepoActivity(null)
        setPrCycle(null)
        setReviewLatency(null)
        setPrPredictions(null)
      })
  }, [selectedRepoId, rangeDays, analyticsScope])

const connectGitHub = (tier: 'standard' | 'full') => {
  window.location.href = `${API_URL}/auth/github/${tier}`
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
      setNotice({ message: getQueueNotice(queued, queueDepth), tone: queued > 0 ? 'success' : 'info' })
    } catch (error) {
      setNotice({ message: `Sync refresh failed: ${errorMessage(error)}`, tone: 'error' })
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
      setNotice({
        message: getQueueNotice(result.queued, result.queueDepth, repo?.fullName ?? 'repository'),
        tone: result.queued > 0 ? 'success' : 'info',
      })
    } catch (error) {
      setNotice({
        message: `Could not sync ${repo?.provider ?? 'repository'} ${repo?.fullName ?? repoId}: ${errorMessage(error)}`,
        tone: 'error',
      })
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

      setNotice({ message: `${isHidden ? 'Hid' : 'Restored'} ${repo.fullName}.`, tone: 'success' })
    } catch (error) {
      setManagerRepos(previousManagerRepos)
      setNotice({ message: error instanceof Error ? error.message : 'Could not update repo visibility.', tone: 'error' })
    } finally {
      setRemovingRepoId(null)
    }
  }

  const restoreAllHiddenRepos = async () => {
    setRestoringRepos(true)
    setNotice(null)
    try {
      const result = await api<{ restored: number }>('/github/repos/visibility/restore-all', { method: 'POST' })
      await Promise.all([refreshDashboard(), loadManagerRepos()])
      setNotice({
        message: result.restored === 1 ? 'Restored 1 repository.' : `Restored ${result.restored} repositories.`,
        tone: result.restored > 0 ? 'success' : 'info',
      })
    } catch (error) {
      setNotice({ message: `Could not restore repositories: ${errorMessage(error)}`, tone: 'error' })
    } finally {
      setRestoringRepos(false)
    }
  }

  const closeManager = () => {
    setManagerOpen(false)
    setManagerQuery('')
    setManagerVisibilityFilter('all')
    setManagerSyncFilter('all')
  }

  const loadSystemStatus = async () => {
    try {
      const nextStatus = await api<SystemStatus>('/auth/system')
      setSystemStatus(nextStatus)
      return nextStatus
    } catch {
      setSystemStatus(null)
      return null
    }
  }

  const openSettings = () => {
    setAccountMenuOpen(false)
    setSettingsOpen(true)
    void loadSystemStatus()
  }

  const loadTeam = async (
    teamId: string,
    filters: { days?: RangeDays; repoId?: string; memberId?: string } = {},
  ) => {
    const days = filters.days ?? teamRangeDays
    const repoId = filters.repoId ?? teamRepoFilter
    const memberId = filters.memberId ?? teamMemberFilter
    const query = new URLSearchParams({ days: days === 'all' ? '0' : String(days) })
    if (repoId !== 'all') query.set('repoId', repoId)
    if (memberId !== 'all') query.set('memberId', memberId)
    const result = await api<TeamDashboard>(`/teams/${teamId}?${query}`)
    setSelectedTeamId(teamId)
    setTeamDashboard(result)
    setTeamRepoIds(result.repositories.map((repo) => repo.id))
    setTeamFeedback(null)
    setTeamDeleteOpen(false)
    setTeamDeleteConfirmation('')
  }

  const openTeamPanel = async () => {
    setTeamPanelOpen(true)
    setTeamPageInitialized(true)
    window.history.pushState({ view: 'team' }, '', '/team')
    setTeamFeedback(null)
    setTeamBusy(true)
    try {
      const result = await api<{ teams: TeamSummary[] }>('/teams')
      setTeams(result.teams)
      const teamId = selectedTeamId ?? result.teams[0]?.id
      if (teamId) await loadTeam(teamId)
    } catch (error) {
      setTeamFeedback({ message: `Could not load teams: ${errorMessage(error)}`, tone: 'error' })
    } finally {
      setTeamBusy(false)
    }
  }

  const closeTeamWorkspace = () => {
    setTeamPanelOpen(false)
    setTeamPageInitialized(false)
    window.history.pushState({ view: 'dashboard' }, '', '/')
  }

  useEffect(() => {
    const handleNavigation = () => setTeamPanelOpen(window.location.pathname === '/team')
    window.addEventListener('popstate', handleNavigation)
    return () => window.removeEventListener('popstate', handleNavigation)
  }, [])

  useEffect(() => {
    if (!user || !teamPanelOpen || teamPageInitialized) return
    setTeamPageInitialized(true)
    setTeamBusy(true)
    void api<{ teams: TeamSummary[] }>('/teams')
      .then(async (result) => {
        setTeams(result.teams)
        if (result.teams[0]) await loadTeam(result.teams[0].id)
      })
      .catch((error) => setTeamFeedback({ message: `Could not load teams: ${errorMessage(error)}`, tone: 'error' }))
      .finally(() => setTeamBusy(false))
  }, [teamPageInitialized, teamPanelOpen, user])

  const createTeam = async () => {
    if (!teamName.trim()) return
    setTeamBusy(true)
    try {
      const result = await api<{ team: TeamSummary }>('/teams', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: teamName }),
      })
      setTeams((current) => [...current, result.team])
      setTeamName('')
      await loadTeam(result.team.id)
      setTeamFeedback({ message: `${result.team.name} was created.`, tone: 'success' })
    } catch (error) {
      setTeamFeedback({ message: `Could not create team: ${errorMessage(error)}`, tone: 'error' })
    } finally { setTeamBusy(false) }
  }

  const saveTeamRepos = async () => {
    if (!selectedTeamId) return
    setTeamBusy(true)
    setTeamFeedback(null)
    try {
      await api(`/teams/${selectedTeamId}/repos`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repoIds: teamRepoIds }),
      })
      await loadTeam(selectedTeamId)
      setTeamFeedback({ message: 'Shared repositories updated.', tone: 'success' })
    } catch (error) {
      setTeamFeedback({ message: `Could not update shared repos: ${errorMessage(error)}`, tone: 'error' })
    } finally { setTeamBusy(false) }
  }

  const addTeamMember = async () => {
    if (!selectedTeamId || !teamMemberUsername.trim()) return
    setTeamBusy(true)
    try {
      await api(`/teams/${selectedTeamId}/members`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: teamMemberUsername }),
      })
      setTeamMemberUsername('')
      await loadTeam(selectedTeamId)
      setTeamFeedback({ message: 'Teammate added.', tone: 'success' })
    } catch (error) {
      setTeamFeedback({ message: `Could not add member: ${errorMessage(error)}`, tone: 'error' })
    } finally { setTeamBusy(false) }
  }

  const deleteTeam = async () => {
    if (!selectedTeamId || teamDeleteConfirmation !== 'delete team') return
    setTeamBusy(true)
    setTeamFeedback(null)
    try {
      await api(`/teams/${selectedTeamId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmation: teamDeleteConfirmation }),
      })
      const result = await api<{ teams: TeamSummary[] }>('/teams')
      setTeams(result.teams)
      setTeamDeleteOpen(false)
      setTeamDeleteConfirmation('')
      const nextTeam = result.teams[0]
      if (nextTeam) {
        await loadTeam(nextTeam.id)
        setTeamFeedback({ message: 'Team deleted.', tone: 'success' })
      } else {
        setSelectedTeamId(null)
        setTeamDashboard(null)
        setTeamRepoIds([])
        setTeamFeedback({ message: 'Team deleted.', tone: 'success' })
      }
    } catch (error) {
      setTeamFeedback({ message: `Could not delete team: ${errorMessage(error)}`, tone: 'error' })
    } finally { setTeamBusy(false) }
  }

  const closeSettings = () => {
    setSettingsOpen(false)
    setGiteaFormOpen(false)
    setGiteaToken('')
  }

  const unlinkProvider = async (provider: 'github' | 'gitea') => {
    setUnlinkingProvider(provider)
    setNotice(null)
    try {
      await api(`/auth/unlink/${provider}`, { method: 'POST' })
      const me = await api<{ user: User }>('/auth/me')
      setUser(me.user)
      if (provider === 'gitea') {
        setGiteaBaseUrl('')
        setGiteaToken('')
        setGiteaFormOpen(false)
      }
      setNotice({ message: `${provider} disconnected.`, tone: 'success' })
    } catch (error) {
      setNotice({ message: `Could not disconnect ${provider}: ${errorMessage(error)}`, tone: 'error' })
    } finally {
      setUnlinkingProvider(null)
    }
  }

  const connectGitea = async () => {
    setConnectingProvider('gitea')
    setNotice(null)
    try {
      await api('/gitea/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: giteaBaseUrl, token: giteaToken }),
      })
      await api('/gitea/repos')
      const me = await api<{ user: User }>('/auth/me')
      setUser(me.user)
      setGiteaToken('')
      setGiteaFormOpen(false)
      await refreshDashboard()
      setNotice({ message: 'Gitea connected and repositories refreshed.', tone: 'success' })
    } catch (error) {
      setNotice({ message: `Could not connect Gitea: ${errorMessage(error)}`, tone: 'error' })
    } finally {
      setConnectingProvider(null)
    }
  }

  const retryFailedRepo = async (failure: SystemStatus['sync']['recentFailures'][number]) => {
    setSyncingRepoId(failure.id)
    setNotice(null)
    try {
      const result = await api<{ queued: number; queueDepth: number }>(
        `/${failure.provider}/repos/${failure.id}/sync/background`,
        { method: 'POST' },
      )
      await Promise.all([refreshDashboard(), loadSystemStatus()])
      setNotice({
        message: getQueueNotice(result.queued, result.queueDepth, failure.fullName),
        tone: 'success',
      })
    } catch (error) {
      setNotice({ message: `Could not retry ${failure.fullName}: ${errorMessage(error)}`, tone: 'error' })
    } finally {
      setSyncingRepoId(null)
    }
  }

  const logout = async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => null)
    localStorage.removeItem(SESSION_STORAGE_KEY)
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
  const repoCountForAverage = Math.max(overview?.repos.length ?? 0, 1)
  const selectedCommitComparison = selectedRepo
    ? compareToWorkspaceAverage(repoSummary?.metrics.commits ?? selectedRepo.commits, totals.commits, repoCountForAverage)
    : null
  const selectedPrComparison = selectedRepo
    ? compareToWorkspaceAverage(repoSummary?.metrics.pullRequests ?? selectedRepo.pullRequests, totals.pullRequests, repoCountForAverage)
    : null
  const insightSummary = insights ?? {
    windowDays: rangeDays,
    activeRepos: 0,
    mergedPullRequests: 0,
    averagePrCycleHours: null,
    averageReviewLatencyHours: null,
    staleRepos: 0,
    queueDepth: 0,
    recommendations: [],
  }
  const recommendations = insightSummary.recommendations ?? []
  const visibleRecommendations = recommendations.filter((recommendation) => {
    const memory = recommendationMemory[recommendation.id]
    if (memory?.dismissedAt) return false
    return !memory?.snoozedUntil || new Date(memory.snoozedUntil) <= new Date()
  })
  const hiddenRecommendationCount = recommendations.length - visibleRecommendations.length

  useEffect(() => {
    setRecommendationMemory((current) => {
      let changed = false
      const next = { ...current }
      for (const recommendation of recommendations) {
        if (!recommendation.metric) continue
        const existing = next[recommendation.id] ?? {}
        if (existing.baseline == null || existing.latest !== recommendation.metric.value) {
          next[recommendation.id] = {
            ...existing,
            baseline: existing.baseline ?? recommendation.metric.value,
            latest: recommendation.metric.value,
            better: recommendation.metric.better,
          }
          changed = true
        }
      }
      if (changed) localStorage.setItem('devpulse:recommendations', JSON.stringify(next))
      return changed ? next : current
    })
  }, [insights])

  const updateRecommendationMemory = (id: string, update: RecommendationMemory[string]) => {
    setRecommendationMemory((current) => {
      const next = { ...current, [id]: { ...current[id], ...update } }
      localStorage.setItem('devpulse:recommendations', JSON.stringify(next))
      return next
    })
  }

  const restoreRecommendations = () => {
    const next = Object.fromEntries(Object.entries(recommendationMemory).map(([id, value]) => [
      id,
      { ...value, dismissedAt: undefined, snoozedUntil: undefined },
    ])) as RecommendationMemory
    localStorage.setItem('devpulse:recommendations', JSON.stringify(next))
    setRecommendationMemory(next)
  }
  const syncHealth = getSyncHealthSummary(insightSummary.queueDepth, insightSummary.staleRepos)
  const rangeLabel = rangeDays === 'all' ? 'all time' : rangeDays === 365 ? 'the last year' : `the last ${rangeDays} days`
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

  if (teamPanelOpen && user) {
    const teamMetrics = teamDashboard?.analytics.totals
    const teamActivity = teamDashboard?.analytics.activity ?? []
    const activityPoints = (key: 'commits' | 'pullRequests' | 'reviews') => teamActivity.map((day) => ({
      key: day.date,
      label: new Date(`${day.date}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      value: day[key],
    }))
    return (
      <main className="app-shell team-workspace-page">
        <section className="team-page-header">
          <div className="aurora aurora-a" />
          <div className="aurora aurora-b" />
          <nav className="topbar workspace-topbar">
            <div className="brand"><span className="brand-mark"><Activity size={18} /></span><span>DevPulse</span></div>
            <WorkspaceSessionMenu
              accountMenuOpen={accountMenuOpen}
              avatarUrl={user.avatarUrl}
              onLogout={logout}
              onOpenSettings={() => { closeTeamWorkspace(); openSettings() }}
              onToggle={() => setAccountMenuOpen((open) => !open)}
              username={user.username}
            />
          </nav>
          <div className="team-page-title">
            <button className="secondary-button compact-button" onClick={closeTeamWorkspace}><ArrowLeft size={17} />Dashboard</button>
            <div><p className="eyebrow">Supervisor Workspace</p><h1>Shared repository performance</h1><p>Team analytics are limited to repositories explicitly shared with this workspace.</p></div>
          </div>
        </section>

        <section className="team-page-content">
          <div className="team-page-toolbar glass-panel">
            <div className="team-tabs">
              {teams.map((team) => <button className={selectedTeamId === team.id ? 'active' : ''} key={team.id} onClick={() => void loadTeam(team.id)}>{team.name}</button>)}
            </div>
            <div className="team-filters">
              <label><span>Repository</span><select value={teamRepoFilter} onChange={(event) => { const value = event.target.value; setTeamRepoFilter(value); if (selectedTeamId) void loadTeam(selectedTeamId, { repoId: value }) }}><option value="all">All shared repos</option>{teamDashboard?.repositories.map((repo) => <option key={repo.id} value={repo.id}>{repo.fullName}</option>)}</select></label>
              <label><span>Timeframe</span><select value={teamRangeDays} onChange={(event) => { const value = event.target.value === 'all' ? 'all' : Number(event.target.value) as RangeDays; setTeamRangeDays(value); if (selectedTeamId) void loadTeam(selectedTeamId, { days: value }) }}><option value={30}>30 days</option><option value={90}>90 days</option><option value={365}>1 year</option><option value="all">All time</option></select></label>
              <label><span>Person</span><select value={teamMemberFilter} onChange={(event) => { const value = event.target.value; setTeamMemberFilter(value); if (selectedTeamId) void loadTeam(selectedTeamId, { memberId: value }) }}><option value="all">All teammates</option>{teamDashboard?.members.map((member) => <option key={member.id} value={member.id}>{member.username}</option>)}</select></label>
            </div>
          </div>

          {teamFeedback ? <div className={`team-feedback ${teamFeedback.tone}`}>{teamFeedback.message}</div> : null}
          {teamDashboard && teamMetrics ? (
            <>
              <div className="team-metrics team-page-metrics">
                <StatPill label="Shared repos" value={String(teamMetrics.repositories)} />
                <StatPill label="Commits" value={String(teamMetrics.commits)} />
                <StatPill label="Pull requests" value={String(teamMetrics.pullRequests)} />
                <StatPill label="Merged PRs" value={String(teamMetrics.mergedPullRequests)} />
                <StatPill label="Reviews" value={String(teamMetrics.reviews)} />
              </div>
              <div className="team-chart-grid">
                <section className="glass-panel"><div className="team-chart-heading"><div><p className="eyebrow">Delivery</p><h2>Commit activity</h2></div><strong>{teamMetrics.commits}</strong></div><TrendLineChart points={activityPoints('commits')} subtitle="Commits over time" tone="mint" valueSuffix="" /></section>
                <section className="glass-panel"><div className="team-chart-heading"><div><p className="eyebrow">Collaboration</p><h2>Pull requests</h2></div><strong>{teamMetrics.pullRequests}</strong></div><TrendLineChart points={activityPoints('pullRequests')} subtitle="PRs opened over time" tone="amber" valueSuffix="" /></section>
                <section className="glass-panel"><div className="team-chart-heading"><div><p className="eyebrow">Responsiveness</p><h2>Reviews</h2></div><strong>{teamMetrics.reviews}</strong></div><TrendLineChart points={activityPoints('reviews')} subtitle="Reviews submitted over time" tone="rose" valueSuffix="" /></section>
              </div>

              <details className="glass-panel team-management">
                <summary><div><p className="eyebrow">Workspace settings</p><h2>Manage team</h2></div><ChevronDown size={20} /></summary>
                <div className="team-toolbar"><div className="team-inline-form"><input value={teamName} onChange={(event) => setTeamName(event.target.value)} placeholder="New team name" /><button className="primary-button compact-button" onClick={() => void createTeam()} disabled={teamBusy || !teamName.trim()}>Create team</button></div></div>
                <div className="team-columns">
                  <section><div className="team-section-heading"><div><p className="eyebrow">Repositories</p><h3>Shared with this team</h3></div>{['owner', 'admin'].includes(teamDashboard.team.role) ? <button className="primary-button compact-button" onClick={() => void saveTeamRepos()} disabled={teamBusy || teamRepoIds.length === teamDashboard.repositories.length && teamRepoIds.every((id) => teamDashboard.repositories.some((repo) => repo.id === id))}>{teamBusy ? <Loader2 className="spin" size={16} /> : <CheckCircle2 size={16} />}Save</button> : null}</div><div className="team-repo-picker">{(overview?.repos ?? []).map((repo) => { const checked = teamRepoIds.includes(repo.id); return <label key={repo.id} className={checked ? 'selected' : ''}><input type="checkbox" checked={checked} disabled={teamBusy} onChange={() => setTeamRepoIds((current) => checked ? current.filter((id) => id !== repo.id) : [...current, repo.id])} /><span><strong>{repo.fullName}</strong><small>{repo.provider}</small></span></label> })}</div></section>
                  <section><div className="team-section-heading"><div><p className="eyebrow">Members</p><h3>{teamDashboard.members.length} teammates</h3></div></div>{['owner', 'admin'].includes(teamDashboard.team.role) ? <div className="team-inline-form"><input value={teamMemberUsername} onChange={(event) => setTeamMemberUsername(event.target.value)} placeholder="GitHub username" /><button className="secondary-button compact-button" onClick={() => void addTeamMember()} disabled={teamBusy || !teamMemberUsername.trim()}>Add</button></div> : null}<div className="team-member-list">{teamDashboard.members.map((member) => <div key={member.id}>{member.avatarUrl ? <img src={member.avatarUrl} alt="" /> : <Users size={18} />}<span><strong>{member.username}</strong><small>{member.role} · {member.commits} commits · {member.pullRequests} PRs</small></span></div>)}</div></section>
                </div>
                {teamDashboard.team.role === 'owner' ? <div className="team-danger-zone"><div><p className="eyebrow">Danger zone</p><h3>Delete this team</h3><span>Repository data stays in DevPulse.</span></div>{teamDeleteOpen ? <div className="team-delete-confirmation"><label><span>Type <strong>delete team</strong> to confirm</span><input value={teamDeleteConfirmation} onChange={(event) => setTeamDeleteConfirmation(event.target.value)} placeholder="delete team" /></label><div><button className="secondary-button compact-button" onClick={() => { setTeamDeleteOpen(false); setTeamDeleteConfirmation('') }}>Cancel</button><button className="danger-button compact-button" onClick={() => void deleteTeam()} disabled={teamBusy || teamDeleteConfirmation !== 'delete team'}><Trash2 size={16} />Delete team</button></div></div> : <button className="danger-button compact-button" onClick={() => setTeamDeleteOpen(true)}><Trash2 size={16} />Delete team</button>}</div> : null}
              </details>
            </>
          ) : <div className="glass-panel empty-state">Create or select a team to start viewing shared analytics.</div>}
        </section>
      </main>
    )
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
              {!user?.giteaConnected ? (
                <button className="secondary-button" onClick={() => { setSettingsOpen(true); setGiteaFormOpen(true) }}>
                  <GitBranch size={18} />
                  Add Gitea
                </button>
              ) : null}
              <button className="secondary-button" onClick={openManager}>
                <Settings2 size={18} />
                Manage Repos
              </button>
              <button className="secondary-button" onClick={() => void openTeamPanel()}>
                <Users size={18} />
                Team Panel
              </button>
              <button className="secondary-button" onClick={load}>
                <RefreshCw size={18} />
                Refresh
              </button>
            </div>
            {notice ? <p className={`notice notice-${notice.tone}`}>{notice.message}</p> : null}
          </div>

          <div className="glass-panel workspace-status-strip">
            <StatusTile label="Live Pulse" value={String(totals.commits)} detail={`${totals.syncedRepos} repositories synced`} />
            <StatusTile label="Active Repos" value={String(insightSummary.activeRepos)} detail={rangeLabel} />
            <StatusTile label="Sync Health" value={syncHealth.value} detail={syncHealth.detail} />
          </div>
        </div>
      </section>

      <section className="dashboard">
        <div className="metric-grid insight-metric-grid summary-metrics">
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
                {([30, 90, 365, 'all'] as const).map((days) => (
                  <button
                    className={rangeDays === days ? 'active' : ''}
                    key={days}
                    onClick={() => setRangeDays(days)}
                  >
                    {days === 'all' ? 'All' : days === 365 ? '1y' : `${days}d`}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <ContributionGraph days={activity?.days ?? []} />
        </section>

        {(insightSummary.recommendations?.length ?? 0) > 0 ? (
        <section className="glass-panel action-insights-panel">
          <div className="section-title compact">
            <div>
              <p className="eyebrow">Recommended Actions</p>
              <h2>What deserves attention</h2>
            </div>
            <Sparkles size={20} />
          </div>
          <div className="action-insights-list">
            {visibleRecommendations.map((recommendation) => {
              const memory = recommendationMemory[recommendation.id]
              const baseline = memory?.baseline
              const current = recommendation.metric?.value
              const change = baseline != null && current != null && baseline !== 0
                ? ((current - baseline) / Math.abs(baseline)) * 100
                : null
              const improved = change != null && (recommendation.metric?.better === 'lower' ? change < 0 : change > 0)
              return (
                <article className={`action-insight ${recommendation.severity}`} key={recommendation.id}>
                  <span className="action-insight-signal" aria-hidden="true" />
                  <div className="action-insight-content">
                    <div className="action-insight-topline">
                      <span className={`impact-pill ${recommendation.impact}`}>{recommendation.impact} impact</span>
                      <span className="action-insight-controls">
                        <button
                          type="button"
                          title="Snooze for 7 days"
                          onClick={() => updateRecommendationMemory(recommendation.id, {
                            snoozedUntil: new Date(Date.now() + 7 * 86_400_000).toISOString(),
                          })}
                        >
                          <Clock3 size={15} />
                        </button>
                        <button
                          type="button"
                          title="Dismiss recommendation"
                          onClick={() => updateRecommendationMemory(recommendation.id, { dismissedAt: new Date().toISOString() })}
                        >
                          <X size={15} />
                        </button>
                      </span>
                    </div>
                    {recommendation.repoFullName ? (
                      <span className="action-insight-repo">{recommendation.repoFullName}</span>
                    ) : null}
                    <strong>{recommendation.title}</strong>
                    <p>{recommendation.detail}</p>
                    <span className="action-insight-evidence">Evidence: {recommendation.evidence}</span>
                    {change != null ? (
                      <span className={`action-insight-progress ${improved ? 'improved' : change === 0 ? 'steady' : 'regressed'}`}>
                        {improved ? 'Improved' : change === 0 ? 'No change yet' : 'Needs attention'}
                        {' · '}{Math.abs(change).toFixed(0)}% {change < 0 ? 'lower' : 'higher'} than first observed
                      </span>
                    ) : null}
                  </div>
                  <div className="action-insight-footer">
                    {recommendation.actionKind === 'sync' && recommendation.repoId ? (
                      <button
                        className="secondary-button compact-button"
                        onClick={() => void syncRepo(recommendation.repoId!)}
                        disabled={syncingRepoId === recommendation.repoId}
                      >
                        {syncingRepoId === recommendation.repoId ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
                        {recommendation.actionLabel}
                      </button>
                    ) : recommendation.actionKind === 'inspect' && recommendation.repoId ? (
                      <button
                        className="secondary-button compact-button"
                        onClick={() => {
                          setSelectedRepoId(recommendation.repoId!)
                          window.requestAnimationFrame(() => document.querySelector('.detail-panel')?.scrollIntoView({ behavior: 'smooth' }))
                        }}
                      >
                        {recommendation.actionLabel}
                      </button>
                    ) : (
                      <span className="action-insight-label">{recommendation.actionLabel}</span>
                    )}
                  </div>
                </article>
              )
            })}
          </div>
          {hiddenRecommendationCount > 0 ? (
            <button className="recommendation-restore" type="button" onClick={restoreRecommendations}>
              Show {hiddenRecommendationCount} hidden recommendation{hiddenRecommendationCount === 1 ? '' : 's'}
            </button>
          ) : null}
        </section>
        ) : null}

        <div className="repository-workspace">
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
                <label className="repo-status-select" aria-label="Filter by sync status">
                  <select
                    value={repoSyncFilter}
                    onChange={(event) => setRepoSyncFilter(event.target.value as RepoSyncFilter)}
                  >
                    <option value="all">Any status</option>
                    <option value="healthy">Healthy</option>
                    <option value="queued">Queued</option>
                    <option value="syncing">Syncing</option>
                    <option value="failed">Failed</option>
                    <option value="unsynced">Unsynced</option>
                  </select>
                  <ChevronDown size={16} aria-hidden="true" />
                </label>
              </div>
            </div>

            {state === 'loading' ? (
              <div className="empty-state">Loading DevPulse data...</div>
            ) : !user?.githubConnected ? (
              <div className="empty-state">
                <p>Connect GitHub App to populate the dashboard.</p>
                <button
                  className="primary-button"
                  onClick={() => connectGitHub('standard')}
                >
                  <Github size={18} />
                  Connect GitHub App
                </button>
              </div>
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
              {selectedRepo.lastSyncError ? (
                <div className="detail-error-callout">
                  <span className="subtle-label">Last sync error</span>
                  <strong>{selectedRepo.lastSyncError}</strong>
                </div>
              ) : null}
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
              <div className="repo-comparison-strip">
                <ComparisonMetric label="Commit volume" comparison={selectedCommitComparison} />
                <ComparisonMetric label="Pull request volume" comparison={selectedPrComparison} />
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
                <p>{rangeDays === 'all' ? 'Across all recorded history' : rangeDays === 365 ? 'Across the last year' : `Across the last ${rangeDays} days`}</p>
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
            <div className={`prediction-block ${predictionsOpen ? 'expanded' : 'collapsed'}`}>
              <button
                className="prediction-toggle"
                type="button"
                aria-expanded={predictionsOpen}
                onClick={() => setPredictionsOpen((open) => !open)}
              >
                <span className="prediction-heading">
                  <BrainCircuit size={20} />
                  <span>
                    <span className="subtle-label">Merge-time forecast</span>
                    <strong>Open pull requests</strong>
                  </span>
                </span>
                <span className="prediction-toggle-meta">
                  <span>{prPredictions?.predictions.length ?? 0} forecasts</span>
                  {predictionsOpen ? <ChevronDown size={20} /> : <ChevronRight size={20} />}
                </span>
              </button>
              {predictionsOpen && prPredictions?.predictions.length ? (
                <div className="prediction-list">
                  {prPredictions.predictions.map((prediction) => (
                    <article className="prediction-row" key={prediction.pullRequest.number}>
                      <div>
                        <span className="subtle-label">PR #{prediction.pullRequest.number}</span>
                        <strong>{prediction.pullRequest.title}</strong>
                      </div>
                      <div className="prediction-value">
                        <strong>{prediction.predictedHours.toFixed(1)}h</strong>
                        <span>
                          {prediction.lowerBoundHours != null && prediction.upperBoundHours != null
                            ? `${prediction.lowerBoundHours.toFixed(1)}–${prediction.upperBoundHours.toFixed(1)}h range`
                            : 'Estimate only'}
                        </span>
                      </div>
                      <span className={`model-badge ${prediction.modelKind}`}>
                        {prediction.modelKind === 'random_forest' ? 'ML model' : 'Baseline'}
                      </span>
                    </article>
                  ))}
                </div>
              ) : predictionsOpen ? (
                <div className="empty-state small">No forecasts yet. Sync a repository with open pull requests.</div>
              ) : null}
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
        </div>
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
              <div className="manager-primary-actions">
                <button className="primary-button" onClick={syncAll} disabled={syncing || !overview?.repos.length}>
                  {syncing ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
                  Sync All Visible
                </button>
                {managerStatusCounts.hidden > 0 ? (
                  <button className="secondary-button" onClick={() => void restoreAllHiddenRepos()} disabled={restoringRepos}>
                    {restoringRepos ? <Loader2 className="spin" size={18} /> : <Eye size={18} />}
                    Show All Hidden
                  </button>
                ) : null}
              </div>
              <span className="subtle-label">{managerStatusCounts.visible} visible · {managerStatusCounts.hidden} hidden</span>
            </div>

            <div className="manager-filter-row">
              <label className="manager-select">
                <span className="subtle-label">Visibility</span>
                <div className="manager-select-wrap">
                  <select
                    value={managerVisibilityFilter}
                    onChange={(event) =>
                      setManagerVisibilityFilter(event.target.value as 'all' | 'visible' | 'hidden')
                    }
                  >
                    <option value="all">All repositories</option>
                    <option value="visible">Visible ({managerStatusCounts.visible})</option>
                    <option value="hidden">Hidden ({managerStatusCounts.hidden})</option>
                  </select>
                  <ChevronDown size={16} />
                </div>
              </label>
              <label className="manager-select">
                <span className="subtle-label">Status</span>
                <div className="manager-select-wrap">
                  <select
                    value={managerSyncFilter}
                    onChange={(event) =>
                      setManagerSyncFilter(
                        event.target.value as 'all' | 'healthy' | 'queued' | 'syncing' | 'failed',
                      )
                    }
                  >
                    <option value="all">All statuses</option>
                    <option value="healthy">Healthy ({managerStatusCounts.statuses.healthy})</option>
                    <option value="queued">Queued ({managerStatusCounts.statuses.queued})</option>
                    <option value="syncing">Syncing ({managerStatusCounts.statuses.syncing})</option>
                    <option value="failed">Failed ({managerStatusCounts.statuses.failed})</option>
                  </select>
                  <ChevronDown size={16} />
                </div>
              </label>
              {managerQuery || managerVisibilityFilter !== 'all' || managerSyncFilter !== 'all' ? (
                <button
                  className="secondary-button compact-button manager-reset-button"
                  onClick={() => {
                    setManagerQuery('')
                    setManagerVisibilityFilter('all')
                    setManagerSyncFilter('all')
                  }}
                >
                  <X size={16} />
                  Reset filters
                </button>
              ) : null}
            </div>

            <label className="manager-search">
              <Search size={18} />
              <input
                value={managerQuery}
                onChange={(event) => setManagerQuery(event.target.value)}
                placeholder="Search repos"
              />
            </label>
            <span className="manager-result-count">
              Showing {filteredManagerRepos.length} of {managerRepos.length} repositories
            </span>

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
                <div className="empty-state">
                  {managerQuery
                    ? 'No repos match that search.'
                    : managerVisibilityFilter === 'hidden'
                      ? 'No hidden repos match those filters.'
                      : 'No repositories match those filters.'}
                </div>
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
                status={githubTierStatus(user, 'standard')}
                detail={githubTierStatus(user, 'standard') === 'connected'
                  ? `PR-only GitHub App installed as ${user.username}`
                  : githubTierStatus(user, 'standard') === 'authorized'
                    ? 'Authorized with GitHub, but no repositories were selected yet. Select repos on GitHub to track PRs without commit or private repo access.'
                    : 'PRs, reviews, and comments without commit or private repo access.'}
                icon={<Github size={30} />}
                isBusy={unlinkingProvider === 'github'}
                name="GitHub Standard"
                onConnect={() => connectGitHub('standard')}
                onUnlink={() => void unlinkProvider('github')}
              />
              <ProviderSetting
                status={githubTierStatus(user, 'full')}
                detail={githubTierStatus(user, 'full') === 'connected'
                  ? `Private repos and commit analytics as ${user.username} · GitHub App installed`
                  : githubTierStatus(user, 'full') === 'authorized'
                    ? 'Authorized with GitHub, but no Full repositories were selected yet. Select repos on GitHub to unlock private repos and commit analytics.'
                  : 'Install Full and select repositories on GitHub to unlock private repos, commit history, activity charts, and stronger ML signals.'}
                icon={<Github size={30} />}
                isBusy={unlinkingProvider === 'github'}
                name="GitHub Full"
                onConnect={() => connectGitHub('full')}
                onUnlink={() => void unlinkProvider('github')}
              />
              <ProviderSetting
                status={user.giteaConnected ? 'connected' : 'disconnected'}
                detail={user.giteaConnected ? `Connected as ${user.giteaUsername}` : 'Connect any Gitea server with your own access token.'}
                icon={<GitBranch size={20} />}
                isBusy={unlinkingProvider === 'gitea' || connectingProvider === 'gitea'}
                name="Gitea"
                onConnect={() => setGiteaFormOpen((open) => !open)}
                onUnlink={() => void unlinkProvider('gitea')}
              />
            </div>

            <div className="access-comparison">
              <div className="access-comparison-header">
                <div>
                  <p className="eyebrow">GitHub Access</p>
                  <h3>Standard vs Full</h3>
                </div>
                <span className="current-tier-pill">
                  Current: {currentGitHubTierLabel(user)}
                </span>
              </div>
              <div className="access-table" role="table" aria-label="GitHub access comparison">
                <div className="access-table-row access-table-head" role="row">
                  <span role="columnheader">Feature</span>
                  <span role="columnheader">Standard</span>
                  <span role="columnheader">Full</span>
                </div>
                {[
                  ['Public repositories', true, true],
                  ['Private repositories you select', false, true],
                  ['Pull requests and reviews', true, true],
                  ['Commit history and activity charts', false, true],
                  ['Burnout and anomaly signals', 'Limited', true],
                  ['Repository code access', false, 'Read-only metadata/code API'],
                ].map(([feature, standard, full]) => (
                  <div className="access-table-row" role="row" key={String(feature)}>
                    <span role="cell">{feature}</span>
                    <span role="cell">{formatAccessCell(standard)}</span>
                    <span role="cell">{formatAccessCell(full)}</span>
                  </div>
                ))}
              </div>
              {!isGitHubTierConnected(user, 'full') ? (
                <div className="access-upgrade-row">
                  <span>{githubTierStatus(user, 'full') === 'authorized' ? 'Full still needs repository selection.' : 'Need private repos or commit analytics?'}</span>
                  <button className="primary-button compact-button" onClick={() => connectGitHub('full')}>
                    <Github size={16} />
                    {githubTierStatus(user, 'full') === 'authorized' ? 'Select Full repos' : 'Switch to Full'}
                  </button>
                </div>
              ) : null}
            </div>

            {!user.giteaConnected && giteaFormOpen ? (
              <form className="gitea-connect-form" onSubmit={(event) => { event.preventDefault(); void connectGitea() }}>
                <div>
                  <strong>Connect your Gitea account</strong>
                  <span>Use your server URL and a personal access token. DevPulse encrypts the token before storing it.</span>
                </div>
                <label>
                  <span>Server URL</span>
                  <input
                    type="url"
                    value={giteaBaseUrl}
                    onChange={(event) => setGiteaBaseUrl(event.target.value)}
                    placeholder="https://gitea.example.com"
                    required
                  />
                </label>
                <label>
                  <span>Personal access token</span>
                  <input
                    type="password"
                    value={giteaToken}
                    onChange={(event) => setGiteaToken(event.target.value)}
                    placeholder="Paste token"
                    autoComplete="off"
                    required
                  />
                </label>
                <div className="gitea-connect-actions">
                  <button type="button" className="secondary-button compact-button" onClick={() => { setGiteaFormOpen(false); setGiteaToken('') }}>Cancel</button>
                  <button type="submit" className="primary-button compact-button" disabled={connectingProvider === 'gitea'}>
                    {connectingProvider === 'gitea' ? <Loader2 className="spin" size={16} /> : <GitBranch size={16} />}
                    {connectingProvider === 'gitea' ? 'Connecting' : 'Connect Gitea'}
                  </button>
                </div>
              </form>
            ) : null}

            <div className="settings-system">
              <p className="eyebrow">Infrastructure</p>
              {systemStatus ? (
                <div className="settings-system-grid">
                  <StatPill label="API" value={systemStatus.api.status.toUpperCase()} />
                  <StatPill label="Mode" value={systemStatus.api.nodeEnv} />
                  <StatPill label="Sync cadence" value={formatInterval(systemStatus.sync.intervalSeconds)} />
                  <StatPill label="Run on start" value={systemStatus.sync.runOnStart ? 'Enabled' : 'Off'} />
                  <StatPill label="Queue depth" value={String(systemStatus.sync.queueDepth)} />
                  <StatPill label="Worker health" value={systemStatus.sync.status === 'healthy' ? 'Healthy' : 'Degraded'} />
                  <StatPill label="Syncing" value={String(systemStatus.sync.repos.syncing)} />
                  <StatPill label="Queued repos" value={String(systemStatus.sync.repos.queued)} />
                  <StatPill label="Failed repos" value={String(systemStatus.sync.repos.failed)} />
                  <StatPill label="GitHub App" value={systemStatus.providers.githubOauthConfigured ? 'Ready' : 'Missing'} />
                  <StatPill label="Gitea connection" value={systemStatus.providers.giteaConfigured ? 'Ready' : 'Missing'} />
                </div>
              ) : (
                <div className="empty-state small">System status is unavailable right now.</div>
              )}
              {systemStatus?.sync.recentFailures.length ? (
                <div className="sync-failure-list">
                  <strong>Recent sync failures</strong>
                  {systemStatus.sync.recentFailures.map((failure) => (
                    <div className="sync-failure-row" key={failure.id}>
                      <div>
                        <strong>{failure.fullName}</strong>
                        <span>{failure.provider} · {formatDate(failure.lastSyncFinishedAt)}</span>
                      </div>
                      <p>{failure.lastSyncError}</p>
                      <button
                        className="secondary-button compact-button"
                        disabled={syncingRepoId === failure.id}
                        onClick={() => void retryFailedRepo(failure)}
                      >
                        {syncingRepoId === failure.id ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
                        Retry
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
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

      {teamPanelOpen && user ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setTeamPanelOpen(false)}>
          <section className="glass-panel team-panel" role="dialog" aria-modal="true" aria-label="Team workspace" onMouseDown={(event) => event.stopPropagation()}>
            <div className="section-title">
              <div><p className="eyebrow">Supervisor Workspace</p><h2>Shared repository performance</h2></div>
              <button className="icon-button" onClick={() => setTeamPanelOpen(false)} title="Close team panel"><X size={18} /></button>
            </div>
            <div className="team-toolbar">
              <div className="team-tabs">
                {teams.map((team) => <button className={selectedTeamId === team.id ? 'active' : ''} key={team.id} onClick={() => void loadTeam(team.id)}>{team.name}</button>)}
              </div>
              <div className="team-inline-form">
                <input value={teamName} onChange={(event) => setTeamName(event.target.value)} placeholder="New team name" />
                <button className="primary-button compact-button" onClick={() => void createTeam()} disabled={teamBusy || !teamName.trim()}>Create</button>
              </div>
            </div>
            {teamFeedback ? <div className={`team-feedback ${teamFeedback.tone}`}>{teamFeedback.message}</div> : null}
            {teamDashboard ? (
              <>
                <div className="team-metrics">
                  <StatPill label="Shared repos" value={String(teamDashboard.totals.repositories)} />
                  <StatPill label="Commits" value={String(teamDashboard.totals.commits)} />
                  <StatPill label="Pull requests" value={String(teamDashboard.totals.pullRequests)} />
                  <StatPill label="Merged PRs" value={String(teamDashboard.totals.mergedPullRequests)} />
                  <StatPill label="Reviews" value={String(teamDashboard.totals.reviews)} />
                </div>
                <div className="team-columns">
                  <section>
                    <div className="team-section-heading">
                      <div><p className="eyebrow">Repositories</p><h3>Explicitly shared with this team</h3></div>
                      {['owner', 'admin'].includes(teamDashboard.team.role) ? (
                        <button
                          className="primary-button compact-button"
                          onClick={() => void saveTeamRepos()}
                          disabled={teamBusy || teamRepoIds.length === teamDashboard.repositories.length && teamRepoIds.every((id) => teamDashboard.repositories.some((repo) => repo.id === id))}
                        >
                          {teamBusy ? <Loader2 className="spin" size={16} /> : <CheckCircle2 size={16} />}
                          Save shared repos
                        </button>
                      ) : null}
                    </div>
                    {['owner', 'admin'].includes(teamDashboard.team.role) ? (
                      <div className="team-repo-picker">
                        {(overview?.repos ?? []).map((repo) => {
                          const checked = teamRepoIds.includes(repo.id)
                          return <label key={repo.id} className={checked ? 'selected' : ''}><input type="checkbox" checked={checked} disabled={teamBusy} onChange={() => setTeamRepoIds((current) => checked ? current.filter((id) => id !== repo.id) : [...current, repo.id])} /><span><strong>{repo.fullName}</strong><small>{repo.provider}</small></span></label>
                        })}
                      </div>
                    ) : null}
                  </section>
                  <section>
                    <div className="team-section-heading"><div><p className="eyebrow">Members</p><h3>{teamDashboard.members.length} teammates</h3></div></div>
                    {['owner', 'admin'].includes(teamDashboard.team.role) ? <div className="team-inline-form"><input value={teamMemberUsername} onChange={(event) => setTeamMemberUsername(event.target.value)} placeholder="GitHub username" /><button className="secondary-button compact-button" onClick={() => void addTeamMember()} disabled={teamBusy || !teamMemberUsername.trim()}>Add</button></div> : null}
                    <div className="team-member-list">{teamDashboard.members.map((member) => <div key={member.id}>{member.avatarUrl ? <img src={member.avatarUrl} alt="" /> : <Users size={18} />}<span><strong>{member.username}</strong><small>{member.role} · {member.commits} commits · {member.pullRequests} PRs in shared repos</small></span></div>)}</div>
                  </section>
                </div>
                {teamDashboard.team.role === 'owner' ? (
                  <div className="team-danger-zone">
                    <div>
                      <p className="eyebrow">Danger zone</p>
                      <h3>Delete this team</h3>
                      <span>This removes the workspace, memberships, and shared-repository links. Repository data stays in DevPulse.</span>
                    </div>
                    {teamDeleteOpen ? (
                      <div className="team-delete-confirmation">
                        <label>
                          <span>Type <strong>delete team</strong> to confirm</span>
                          <input
                            value={teamDeleteConfirmation}
                            onChange={(event) => setTeamDeleteConfirmation(event.target.value)}
                            placeholder="delete team"
                            autoComplete="off"
                          />
                        </label>
                        <div>
                          <button className="secondary-button compact-button" onClick={() => { setTeamDeleteOpen(false); setTeamDeleteConfirmation('') }} disabled={teamBusy}>Cancel</button>
                          <button className="danger-button compact-button" onClick={() => void deleteTeam()} disabled={teamBusy || teamDeleteConfirmation !== 'delete team'}>
                            {teamBusy ? <Loader2 className="spin" size={16} /> : <Trash2 size={16} />}
                            Delete team
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button className="danger-button compact-button" onClick={() => setTeamDeleteOpen(true)}>
                        <Trash2 size={16} />
                        Delete team
                      </button>
                    )}
                  </div>
                ) : null}
              </>
            ) : <div className="empty-state">Create a team to choose shared repositories and invite teammates.</div>}
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
        detail: `${week.reviewedPrs} reviewed ${week.reviewedPrs === 1 ? 'PR' : 'PRs'}`,
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
        detail: `${week.mergedPrs} merged ${week.mergedPrs === 1 ? 'PR' : 'PRs'}`,
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

function formatAccessCell(value: boolean | string) {
  if (value === true) return <span className="access-cell included"><CheckCircle2 size={16} /> Included</span>
  if (value === false) return <span className="access-cell excluded"><X size={16} /> Not included</span>
  return <span className="access-cell partial">{value}</span>
}

function githubDisplayTier(user: User) {
  if (user.githubTiers?.full.installed) return 'full'
  if (user.githubTiers?.standard.installed) return 'standard'
  if (user.githubTiers?.full.authorized) return 'full'
  if (user.githubTiers?.standard.authorized) return 'standard'
  if (user.githubAppInstalled && (user.githubAppKind === 'standard' || user.githubAppKind === 'full')) {
    return user.githubAppKind
  }
  if (user.githubConnected && (user.accessTier === 'standard' || user.accessTier === 'full')) {
    return user.accessTier
  }
  return null
}

function isGitHubTierConnected(user: User, tier: 'standard' | 'full') {
  if (user.githubTiers) return user.githubTiers[tier].installed
  return user.githubAppInstalled && user.githubAppKind === tier
}

function githubTierStatus(user: User, tier: 'standard' | 'full'): ConnectionStatus {
  if (isGitHubTierConnected(user, tier)) return 'connected'
  if (user.githubTiers?.[tier].authorized) return 'authorized'
  if (user.githubConnected && user.accessTier === tier) return 'authorized'
  return 'disconnected'
}

function currentGitHubTierLabel(user: User) {
  const tier = githubDisplayTier(user)
  if (tier === 'full') return isGitHubTierConnected(user, 'full') ? 'Full' : 'Full setup needed'
  if (tier === 'standard') return isGitHubTierConnected(user, 'standard') ? 'Standard' : 'Standard setup needed'
  return 'None'
}

function ProviderSetting({
  detail,
  icon,
  isBusy,
  name,
  onConnect,
  onUnlink,
  status,
}: {
  detail: string
  icon: React.ReactNode
  isBusy: boolean
  name: string
  onConnect: () => void
  onUnlink: () => void
  status: ConnectionStatus
}) {
  const connected = status === 'connected'
  const authorized = status === 'authorized'
  const statusLabel = connected ? 'Connected' : authorized ? 'Needs repos' : 'Disconnected'

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
        <span className={`connection-pill ${status}`}>
          {statusLabel}
        </span>
        {connected ? (
          <button className="danger-button compact-button" onClick={onUnlink} disabled={isBusy}>
            {isBusy ? <Loader2 className="spin" size={16} /> : <Link2Off size={16} />}
            Unlink
          </button>
        ) : (
          <button className="secondary-button compact-button" onClick={onConnect} disabled={isBusy}>
            {isBusy ? <Loader2 className="spin" size={16} /> : null}
            {isBusy ? 'Connecting' : authorized ? 'Select repos' : 'Connect'}
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

function ComparisonMetric({
  label,
  comparison,
}: {
  label: string
  comparison: ReturnType<typeof compareToWorkspaceAverage> | null
}) {
  if (!comparison) return null
  return (
    <div className="comparison-metric">
      <span>{label}</span>
      <strong className={comparison.tone}>{comparison.label}</strong>
      <small>Workspace average {comparison.average.toFixed(1)}</small>
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
  const hoveredPoint = coords.find((point) => point.key === hoveredKey) ?? null

  const updateHoveredPoint = (clientX: number, currentTarget: EventTarget & SVGSVGElement) => {
    const matrix = currentTarget.getScreenCTM()
    if (!matrix) return

    const cursor = currentTarget.createSVGPoint()
    cursor.x = clientX
    cursor.y = 0
    const relativeX = cursor.matrixTransform(matrix.inverse()).x
    const nextPoint = coords.reduce((closest, point) =>
      Math.abs(point.x - relativeX) < Math.abs(closest.x - relativeX) ? point : closest,
    )
    setHoveredKey(nextPoint.key)
  }

  return (
    <div className={`trend-chart-shell tone-${tone}`}>
      <div className="trend-chart-header">
        <span>{subtitle}</span>
        <span className="trend-chart-readout">
          {hoveredPoint
            ? `${hoveredPoint.label} · ${hoveredPoint.value.toFixed(hoveredPoint.value >= 10 ? 0 : 1)}${valueSuffix}${hoveredPoint.detail ? ` · ${hoveredPoint.detail}` : ''}`
            : `${max.toFixed(max >= 10 ? 0 : 1)}${valueSuffix} max`}
        </span>
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
