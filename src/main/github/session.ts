import { GitHubAuthError, pollForToken, requestDeviceCode } from './auth'
import { GitHubApiError, getBranchStatus, getViewer, listInstallations, listRepos } from './api'
import { clearToken, loadToken, saveToken } from './tokens'
import type { AuthState, BranchStatus, Repo } from '../../shared/github'

/**
 * The signed-in GitHub session.
 *
 * One at a time, held in main. The token never crosses into the renderer —
 * the UI asks for repositories and gets repositories, never the credential
 * that fetched them.
 */

let token: string | null = null
let state: AuthState = { status: 'signed-out' }
let pending: AbortController | null = null

/** Restore a stored sign-in, if there is one and it still works. */
export async function restore(): Promise<AuthState> {
  const stored = loadToken()
  if (!stored) return (state = { status: 'signed-out' })

  try {
    const viewer = await getViewer(stored)
    token = stored
    return (state = { status: 'signed-in', ...viewer })
  } catch (error) {
    // A revoked token is the expected case, not an exceptional one: someone
    // removed the app on GitHub and the stored credential is now waste paper.
    if (error instanceof GitHubApiError && error.status === 401) {
      clearToken()
      return (state = { status: 'signed-out' })
    }
    // Anything else — no network, GitHub down — leaves the token alone. Losing
    // a working sign-in because the wifi dropped would be its own bug.
    return (state = { status: 'failed', error: (error as Error).message })
  }
}

export function currentState(): AuthState {
  return state
}

export interface SignInHandlers {
  /** Called as soon as GitHub issues a code, so the UI can show it. */
  onCode: (state: AuthState) => void
}

/**
 * Start a device flow sign-in and see it through.
 *
 * Resolves when the user has finished on GitHub, or with a failed state
 * explaining why not. Only one sign-in runs at a time; starting another
 * cancels the first, since two codes on screen would be worse than none.
 */
export async function signIn(handlers: SignInHandlers): Promise<AuthState> {
  pending?.abort()
  pending = new AbortController()
  const signal = pending.signal

  try {
    const { code, deviceCode, interval } = await requestDeviceCode()
    state = { status: 'awaiting-user', code }
    handlers.onCode(state)

    const fresh = await pollForToken({ deviceCode, interval, expiresIn: code.expiresIn, signal })
    const viewer = await getViewer(fresh)

    token = fresh
    const stored = saveToken(fresh)
    state = { status: 'signed-in', ...viewer }

    // A sign-in that worked but could not be saved is still a sign-in. Say so
    // rather than failing, and let it last as long as the app is open.
    if (!stored.saved && stored.reason) console.warn(stored.reason)

    return state
  } catch (error) {
    const message =
      error instanceof GitHubAuthError || error instanceof GitHubApiError
        ? error.message
        : `Sign-in failed (${(error as Error).message}).`
    return (state = { status: 'failed', error: message })
  } finally {
    pending = null
  }
}

export function cancelSignIn(): void {
  pending?.abort()
  pending = null
  if (state.status === 'awaiting-user') state = { status: 'signed-out' }
}

export function signOut(): AuthState {
  pending?.abort()
  clearToken()
  token = null
  return (state = { status: 'signed-out' })
}

/**
 * Every repository this installation of the App may touch.
 *
 * Flattened across installations, because a user does not think in
 * installations — they think in repositories.
 */
export async function repositories(): Promise<Repo[]> {
  if (!token) throw new GitHubApiError('Not signed in.', 401)

  const installations = await listInstallations(token)
  const lists = await Promise.all(installations.map((i) => listRepos(token as string, i.id)))
  return lists
    .flat()
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || a.fullName.localeCompare(b.fullName))
}

/**
 * What the project's own CI says about a branch.
 *
 * Read-only, per §8. Pitwall shows what the team's pipeline reports and runs
 * nothing itself.
 */
export async function branchStatus(fullName: string, ref: string): Promise<BranchStatus> {
  if (!token) throw new GitHubApiError('Not signed in.', 401)
  return getBranchStatus(token, fullName, ref)
}

/** True when the app has been authorised but granted nothing. */
export async function hasNoInstallations(): Promise<boolean> {
  if (!token) return false
  return (await listInstallations(token)).length === 0
}
