import { useCallback, useEffect, useState } from 'react'

import type { AuthState, BranchStatus, Repo } from '../../shared/github'

/**
 * Signing in, and choosing what to work on.
 *
 * The device flow is two screens in one: a code to type on github.com, then a
 * list of repositories the app was actually granted. A repository that was not
 * granted never appears here, which is the promise §7 makes to org admins.
 */
export default function GitHub({
  onPick,
  picked
}: {
  onPick: (repo: Repo | null) => void
  picked: Repo | null
}): JSX.Element {
  const [auth, setAuth] = useState<AuthState>({ status: 'signed-out' })
  const [repos, setRepos] = useState<Repo[] | null>(null)
  const [busy, setBusy] = useState(true)
  const [noInstalls, setNoInstalls] = useState(false)
  const [copied, setCopied] = useState(false)
  const [status, setStatus] = useState<BranchStatus | null>(null)

  // What the project's own CI says about the chosen repository. Read-only per
  // §8: shown, never run.
  useEffect(() => {
    setStatus(null)
    if (!picked) return
    let cancelled = false
    void window.pitwall.github
      .branchStatus(picked.fullName, picked.defaultBranch)
      .then((s) => {
        if (!cancelled) setStatus(s)
      })
      .catch(() => {
        if (!cancelled) setStatus(null)
      })
    return () => {
      cancelled = true
    }
  }, [picked])

  // The device code arrives while signIn is still pending, so it comes over its
  // own channel rather than as a return value.
  useEffect(() => window.pitwall.github.onState(setAuth), [])

  const loadRepos = useCallback(async () => {
    setNoInstalls(await window.pitwall.github.hasNoInstallations())
    setRepos(await window.pitwall.github.repositories().catch(() => []))
  }, [])

  useEffect(() => {
    void (async () => {
      const restored = await window.pitwall.github.restore()
      setAuth(restored)
      if (restored.status === 'signed-in') await loadRepos()
      setBusy(false)
    })()
  }, [loadRepos])

  const signIn = async (): Promise<void> => {
    setBusy(true)
    const result = await window.pitwall.github.signIn()
    setAuth(result)
    if (result.status === 'signed-in') await loadRepos()
    setBusy(false)
  }

  const signOut = async (): Promise<void> => {
    setAuth(await window.pitwall.github.signOut())
    setRepos(null)
    onPick(null)
  }

  if (auth.status === 'awaiting-user') {
    const openGitHub = (): void => void window.pitwall.openExternal(auth.code.verificationUri)
    const copyCode = async (): Promise<void> => {
      await navigator.clipboard.writeText(auth.code.userCode)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    }

    return (
      <section className="signin">
        <p className="signin__lead">Enter this code on GitHub to finish signing in.</p>
        <div className="signin__code">
          <span className="signin__digits">{auth.code.userCode}</span>
          <button type="button" className="btn btn--tiny" onClick={() => void copyCode()}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <div className="actions">
          <button type="button" className="btn btn--primary" onClick={openGitHub}>
            Open GitHub
          </button>
          <button type="button" className="btn" onClick={() => void window.pitwall.github.cancelSignIn()}>
            Cancel
          </button>
        </div>
        <p className="signin__note">Waiting for you to finish on github.com…</p>
      </section>
    )
  }

  if (auth.status !== 'signed-in') {
    return (
      <section className="signin">
        <p className="signin__lead">Connect GitHub to choose a repository.</p>
        {auth.status === 'failed' && <p className="signin__error">{auth.error}</p>}
        <button type="button" className="btn btn--primary" onClick={() => void signIn()} disabled={busy}>
          {busy ? 'Working…' : 'Sign in with GitHub'}
        </button>
      </section>
    )
  }

  return (
    <section className="repos">
      <header className="repos__head">
        <span className="repos__who">
          Signed in as <strong>{auth.login}</strong>
        </span>
        <button type="button" className="linklike" onClick={() => void loadRepos()}>
          Refresh
        </button>
        <button type="button" className="linklike" onClick={() => void signOut()}>
          Sign out
        </button>
      </header>

      {noInstalls ? (
        <p className="repos__empty">
          Pitwall is authorised but has not been installed on any account, so it can see no repositories. Install
          it from the app&apos;s page on GitHub and choose which repositories it may use.
        </p>
      ) : repos === null ? (
        <p className="repos__empty">Loading repositories…</p>
      ) : repos.length === 0 ? (
        <p className="repos__empty">No repositories were granted to Pitwall on this account.</p>
      ) : (
        <ul className="repolist">
          {repos.map((repo) => (
            <li key={repo.fullName}>
              <button
                type="button"
                className={`repo ${picked?.fullName === repo.fullName ? 'repo--picked' : ''}`}
                onClick={() => onPick(repo)}
              >
                <span className="repo__name">{repo.fullName}</span>
                <span className="repo__meta">
                  {repo.private ? 'private' : 'public'} · {repo.defaultBranch}
                  {picked?.fullName === repo.fullName && status && (
                    <span className={`ci ci--${status.state ?? 'none'}`}>
                      {status.state === null
                        ? 'no checks'
                        : `${status.state}${status.checks.length ? ` · ${status.checks.length}` : ''}`}
                      {status.deployment ? ` · ${status.deployment.state}` : ''}
                    </span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
