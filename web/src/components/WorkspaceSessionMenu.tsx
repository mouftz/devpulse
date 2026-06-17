import { ChevronDown, Github, LogOut, Settings2 } from 'lucide-react'

type WorkspaceSessionMenuProps = {
  avatarUrl: string | null
  username: string
  accountMenuOpen: boolean
  onToggle: () => void
  onOpenSettings: () => void
  onLogout: () => void
}

export function WorkspaceSessionMenu({
  avatarUrl,
  username,
  accountMenuOpen,
  onToggle,
  onOpenSettings,
  onLogout,
}: WorkspaceSessionMenuProps) {
  return (
    <div className="session-actions">
      <button
        className="profile-chip"
        onClick={onToggle}
        aria-expanded={accountMenuOpen}
        aria-haspopup="menu"
      >
        {avatarUrl ? <img src={avatarUrl} alt="" /> : <Github size={18} />}
        <span>{username}</span>
        <ChevronDown size={16} />
      </button>
      {accountMenuOpen ? (
        <div className="account-menu" role="menu">
          <button onClick={onOpenSettings} role="menuitem">
            <Settings2 size={17} />
            Settings
          </button>
          <button onClick={onLogout} role="menuitem">
            <LogOut size={17} />
            Log out
          </button>
        </div>
      ) : null}
    </div>
  )
}
