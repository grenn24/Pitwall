/**
 * GitHub identity and the shapes the UI needs from it.
 *
 * Pitwall authenticates with a GitHub App through the device flow. There is no
 * client secret anywhere in this codebase, and there cannot be: a secret shipped
 * inside a desktop app is a secret published. Spec §7 covers the consequence —
 * tokens are user-to-server, so the user is the PR author and cannot approve
 * their own pull request, which v0 does not need them to.
 */

/** Public identifier for the GitHub App. Not a secret; it ships in every client. */
export const GITHUB_CLIENT_ID = 'Iv23likg9FOXzM64743f'

/** What the user has to do to finish signing in. */
export interface DeviceCode {
  /** Shown to the user to type into GitHub. */
  userCode: string
  /** Where they type it. */
  verificationUri: string
  /** Seconds until this code is dead. */
  expiresIn: number
}

export type AuthState =
  | { status: 'signed-out' }
  | { status: 'awaiting-user'; code: DeviceCode }
  | { status: 'signed-in'; login: string; name: string | null; avatarUrl: string | null }
  | { status: 'failed'; error: string }

export interface Repo {
  /** owner/name, as everyone writes it. */
  fullName: string
  /** What Pitwall clones. */
  cloneUrl: string
  defaultBranch: string
  private: boolean
  /** Null when the repository has never been pushed to. */
  updatedAt: string | null
}

/** Where a branch stands with the project's own CI, read only. */
export interface BranchStatus {
  /** GitHub's rollup: success, failure, pending, or null when nothing ran. */
  state: 'success' | 'failure' | 'pending' | 'neutral' | null
  /** Individual check runs, most recent first. */
  checks: { name: string; state: string; url: string | null }[]
  /** Deployment status, when the project deploys from this branch. */
  deployment: { environment: string; state: string; url: string | null } | null
}
