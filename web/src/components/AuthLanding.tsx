import { Activity, GitBranch, Github, Lock, ShieldCheck } from 'lucide-react'

type AuthLandingProps = {
  onConnectGitHub: (tier: 'standard' | 'full') => void
}

export function AuthLanding({ onConnectGitHub }: AuthLandingProps) {
  return (
    <main className="app-shell auth-shell">
      <section className="hero auth-hero">
        <div className="aurora aurora-a" />
        <div className="aurora aurora-b" />
        <nav className="topbar">
          <div className="brand">
            <span className="brand-mark">
              <Activity size={18} />
            </span>
            <span>DevPulse</span>
          </div>
        </nav>
        <div className="auth-layout">
          <section className="auth-copy">
            <p className="eyebrow">Developer Analytics</p>
            <h1 className="auth-title">Connect once, then land straight in your engineering stats.</h1>
            <p className="hero-text auth-text">
              Bring repository activity, pull requests, and review timing into one workspace.
              Choose how much GitHub access to grant — you can change this later.
            </p>
            <div className="auth-pills">
              <span>Commit history</span>
              <span>PR cycle trends</span>
              <span>Review latency</span>
              <span>Repository health</span>
            </div>
          </section>
          <section className="glass-panel auth-panel">
            <div>
              <p className="eyebrow">Get Started</p>
              <h2>Choose your access level</h2>
            </div>
            <div className="auth-provider-list">
              <button
                className="auth-provider-card primary-auth-card"
                onClick={() => onConnectGitHub('standard')}
              >
                <ShieldCheck size={22} />
                <div>
                  <strong>Standard — PR-only access</strong>
                  <span>
                    Pull requests, reviews, and comments. DevPulse never requests access
                    to your repository code.
                  </span>
                </div>
              </button>
              <button
                className="auth-provider-card primary-auth-card"
                onClick={() => onConnectGitHub('full')}
              >
                <Lock size={22} />
                <div>
                  <strong>Full — adds commit data</strong>
                  <span>
                    Everything in Standard, plus commit frequency and timing for sharper
                    burnout signals. Grants read-only repository access.
                  </span>
                </div>
              </button>
              <div className="auth-provider-card secondary-auth-card">
                <GitBranch size={22} />
                <div>
                  <strong>Add Gitea next</strong>
                  <span>Available right after sign-in from the workspace header and settings.</span>
                </div>
              </div>
            </div>
            <div className="auth-note">
              <span className="connection-pill connected">GitHub App</span>
              <span className="connection-pill disconnected">Gitea optional</span>
            </div>
          </section>
        </div>
      </section>
    </main>
  )
}