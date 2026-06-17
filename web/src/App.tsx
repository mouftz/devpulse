import { useEffect, useMemo, useState } from 'react'
import {
  Activity,
  ArrowUpRight,
  CheckCircle2,
  Flame,
  GitBranch,
  Github,
  LogOut,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react'

const API_URL = 'http://localhost:3000'

type User = {
  id: string
  githubId: string
  username: string
  email: string
  avatarUrl: string | null
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
    fullName: string
    lastSyncedAt: string | null
    commits: number
    pullRequests: number
  }>
}

type ActivityDay = {
  date: string
  count: number
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

type LoadState = 'idle' | 'loading' | 'ready' | 'error'

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

export function App() {
  const [user, setUser] = useState<User | null>(null)
  const [overview, setOverview] = useState<Overview | null>(null)
  const [activity, setActivity] = useState<ActivitySummary | null>(null)
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null)
  const [repoSummary, setRepoSummary] = useState<RepoSummary | null>(null)
  const [state, setState] = useState<LoadState>('idle')
  const [syncing, setSyncing] = useState(false)
  const [syncingRepoId, setSyncingRepoId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = async () => {
    setState('loading')
    try {
      const me = await api<{ user: User }>('/auth/me')
      setUser(me.user)

      await api('/github/repos')
      const [nextOverview, nextActivity] = await Promise.all([
        api<Overview>('/github/overview'),
        api<ActivitySummary>('/github/activity'),
      ])
      setOverview(nextOverview)
      setActivity(nextActivity)
      setSelectedRepoId((current) => current ?? nextOverview.repos.find((repo) => repo.lastSyncedAt)?.id ?? null)
      setState('ready')
    } catch {
      setUser(null)
      setOverview(null)
      setActivity(null)
      setSelectedRepoId(null)
      setRepoSummary(null)
      setState('error')
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const topRepos = useMemo(() => {
    return [...(overview?.repos ?? [])].sort((a, b) => b.commits - a.commits).slice(0, 5)
  }, [overview])

  const selectedRepo = useMemo(() => {
    return overview?.repos.find((repo) => repo.id === selectedRepoId) ?? null
  }, [overview, selectedRepoId])

  useEffect(() => {
    if (!selectedRepoId) {
      setRepoSummary(null)
      return
    }

    void api<RepoSummary>(`/github/repos/${selectedRepoId}/summary`)
      .then(setRepoSummary)
      .catch(() => setRepoSummary(null))
  }, [selectedRepoId])

  const connectGitHub = () => {
    window.location.href = `${API_URL}/auth/github`
  }

  const syncAll = async () => {
    setSyncing(true)
    setNotice(null)
    try {
      const result = await api<{ synced: number; failed: number }>('/github/repos/sync-all')
      const [nextOverview, nextActivity] = await Promise.all([
        api<Overview>('/github/overview'),
        api<ActivitySummary>('/github/activity'),
      ])
      setOverview(nextOverview)
      setActivity(nextActivity)
      setNotice(`Synced ${result.synced} repos${result.failed ? `, ${result.failed} failed` : ''}.`)
    } finally {
      setSyncing(false)
    }
  }

  const syncRepo = async (repoId: string) => {
    setSyncingRepoId(repoId)
    setNotice(null)
    try {
      await api(`/github/repos/${repoId}/sync`, { method: 'POST' })
      const [nextOverview, nextActivity, nextSummary] = await Promise.all([
        api<Overview>('/github/overview'),
        api<ActivitySummary>('/github/activity'),
        api<RepoSummary>(`/github/repos/${repoId}/summary`),
      ])
      setOverview(nextOverview)
      setActivity(nextActivity)
      setRepoSummary(nextSummary)
      setSelectedRepoId(repoId)
      setNotice(`Synced ${nextSummary.repo.fullName}.`)
    } finally {
      setSyncingRepoId(null)
    }
  }

  const logout = async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => null)
    setUser(null)
    setOverview(null)
    setActivity(null)
    setSelectedRepoId(null)
    setRepoSummary(null)
    setNotice(null)
  }

  const totals = overview?.totals ?? { repos: 0, syncedRepos: 0, commits: 0, pullRequests: 0 }

  return (
    <main className="app-shell">
      <section className="hero">
        <div className="aurora aurora-a" />
        <div className="aurora aurora-b" />
        <nav className="topbar">
          <div className="brand">
            <span className="brand-mark">
              <Activity size={18} />
            </span>
            <span>DevPulse</span>
          </div>
          {user ? (
            <div className="session-actions">
              <div className="profile-chip">
                {user.avatarUrl ? <img src={user.avatarUrl} alt="" /> : <Github size={18} />}
                <span>{user.username}</span>
              </div>
              <button className="icon-button" onClick={logout} title="Log out">
                <LogOut size={18} />
              </button>
            </div>
          ) : (
            <button className="ghost-button" onClick={connectGitHub}>
              <Github size={18} />
              Connect GitHub
            </button>
          )}
        </nav>

        <div className="hero-grid">
          <div className="hero-copy">
            <p className="eyebrow">Developer Analytics</p>
            <h1>Engineering signal, pulled straight from your GitHub flow.</h1>
            <p className="hero-text">
              Track repository activity, sync commits and pull requests, and turn raw engineering
              work into clean operating metrics.
            </p>
            <div className="hero-actions">
              <button className="primary-button" onClick={user ? syncAll : connectGitHub} disabled={syncing}>
                {syncing ? <Loader2 className="spin" size={18} /> : user ? <RefreshCw size={18} /> : <Github size={18} />}
                {user ? 'Sync All Repos' : 'Connect GitHub'}
              </button>
              <button className="secondary-button" onClick={load}>
                <RefreshCw size={18} />
                Refresh
              </button>
            </div>
            {notice ? <p className="notice">{notice}</p> : null}
          </div>

          <div className="glass-panel pulse-panel">
            <div className="panel-heading">
              <span>Live Pulse</span>
              <ShieldCheck size={18} />
            </div>
            <div className="pulse-score">{totals.commits}</div>
            <p>commits synced across {totals.syncedRepos} repositories</p>
            <div className="pulse-bars">
              <span style={{ height: '42%' }} />
              <span style={{ height: '66%' }} />
              <span style={{ height: '54%' }} />
              <span style={{ height: '86%' }} />
              <span style={{ height: '72%' }} />
              <span style={{ height: '48%' }} />
              <span style={{ height: '61%' }} />
            </div>
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

        <section className="glass-panel contribution-panel">
          <div className="section-title">
            <div>
              <p className="eyebrow">Commit Rhythm</p>
              <h2>{activity?.total ?? 0} contributions in the last year</h2>
            </div>
            <span className="subtle-label">Commits</span>
          </div>
          <ContributionGraph days={activity?.days ?? []} />
        </section>

        <div className="content-grid">
          <section className="glass-panel repo-panel">
            <div className="section-title">
              <div>
                <p className="eyebrow">Repository Index</p>
                <h2>Synced GitHub repos</h2>
              </div>
              <button className="icon-button" onClick={syncAll} disabled={!user || syncing} title="Sync all repos">
                {syncing ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
              </button>
            </div>

            {state === 'loading' ? (
              <div className="empty-state">Loading DevPulse data...</div>
            ) : !user ? (
              <div className="empty-state">Connect GitHub to populate the dashboard.</div>
            ) : (
              <div className="repo-table">
                {(overview?.repos ?? []).map((repo) => (
                  <button
                    className={`repo-row ${repo.id === selectedRepoId ? 'selected' : ''}`}
                    key={repo.id}
                    onClick={() => setSelectedRepoId(repo.id)}
                  >
                    <div>
                      <strong>{repo.fullName}</strong>
                      <span>{formatDate(repo.lastSyncedAt)}</span>
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
                <span>Avg PR cycle</span>
                <strong>
                  {repoSummary?.metrics.averagePrCycleHours == null
                    ? 'No data'
                    : `${repoSummary.metrics.averagePrCycleHours.toFixed(1)}h`}
                </strong>
              </div>
            </div>
          ) : (
            <div className="empty-state small">Click a repo row to inspect it.</div>
          )}
        </section>
      </section>
    </main>
  )
}

function Metric({ title, value, icon }: { title: string; value: number; icon: React.ReactNode }) {
  return (
    <div className="glass-panel metric-card">
      <div className="metric-icon">{icon}</div>
      <span>{title}</span>
      <strong>{value}</strong>
    </div>
  )
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
