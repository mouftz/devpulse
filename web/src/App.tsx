import { useEffect, useMemo, useState } from 'react'
import {
  Activity,
  ArrowUpRight,
  CheckCircle2,
  Flame,
  GitBranch,
  Github,
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
  const [state, setState] = useState<LoadState>('idle')
  const [syncing, setSyncing] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const load = async () => {
    setState('loading')
    try {
      const me = await api<{ user: User }>('/auth/me')
      setUser(me.user)

      await api('/github/repos')
      const nextOverview = await api<Overview>('/github/overview')
      setOverview(nextOverview)
      setState('ready')
    } catch {
      setUser(null)
      setOverview(null)
      setState('error')
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const topRepos = useMemo(() => {
    return [...(overview?.repos ?? [])].sort((a, b) => b.commits - a.commits).slice(0, 5)
  }, [overview])

  const connectGitHub = () => {
    window.location.href = `${API_URL}/auth/github`
  }

  const syncAll = async () => {
    setSyncing(true)
    setNotice(null)
    try {
      const result = await api<{ synced: number; failed: number }>('/github/repos/sync-all')
      const nextOverview = await api<Overview>('/github/overview')
      setOverview(nextOverview)
      setNotice(`Synced ${result.synced} repos${result.failed ? `, ${result.failed} failed` : ''}.`)
    } finally {
      setSyncing(false)
    }
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
            <div className="profile-chip">
              {user.avatarUrl ? <img src={user.avatarUrl} alt="" /> : <Github size={18} />}
              <span>{user.username}</span>
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
                  <div className="repo-row" key={repo.id}>
                    <div>
                      <strong>{repo.fullName}</strong>
                      <span>{formatDate(repo.lastSyncedAt)}</span>
                    </div>
                    <div className="repo-stats">
                      <span>{repo.commits} commits</span>
                      <span>{repo.pullRequests} PRs</span>
                    </div>
                  </div>
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
