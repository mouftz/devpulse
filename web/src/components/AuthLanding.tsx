import { Activity, GitBranch, Github } from 'lucide-react'

type AuthLandingProps = {
  onConnectGitHub: () => void
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
              DevPulse signs you in with GitHub today, then lets you layer Gitea on top inside
              the product.
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
              <h2>Choose your connection path</h2>
            </div>
            <div className="auth-provider-list">
              <button className="auth-provider-card primary-auth-card" onClick={onConnectGitHub}>
                <Github size={22} />
                <div>
                  <strong>Continue with GitHub</strong>
                  <span>Creates your DevPulse session and opens the stats workspace.</span>
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
              <span className="connection-pill connected">GitHub OAuth</span>
              <span className="connection-pill disconnected">Gitea optional</span>
            </div>
          </section>
        </div>
      </section>
    </main>
  )
}
