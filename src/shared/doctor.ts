/**
 * What the environment probe found.
 *
 * Pitwall checks and explains; it does not install anything. Driving those
 * installs meant fighting the Store, elevation, account prompts and consoles
 * that suspend themselves, and every workaround removed one failure while
 * adding another. Run by a person in their own terminal, they simply work.
 */

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'checking' | 'pending'

export type CheckId = 'wsl' | 'distro' | 'git' | 'docker' | 'compose'

export interface CheckResult {
  /** Stable id, used by the UI and by tests. */
  id: CheckId
  /** Human label, shown in the first-run screen. */
  label: string
  status: CheckStatus
  /** What we found. Always concrete — a version, a name, a reason. */
  detail: string
  /** What to do about it. Present only when status is not 'ok'. */
  remediation?: string
  /**
   * The exact command to run, when the fix is one.
   *
   * Offered with a copy button. Retyping a command from a screen is where
   * typos come from, and on a fresh machine that is exactly what someone is
   * doing.
   */
  command?: string
  /** Where the command should be run, when it matters. */
  shell?: string
  /** Documentation worth opening, when it genuinely helps. */
  docsUrl?: string
  /** Raw output, kept for the log pane. Never shown by default. */
  raw?: string
}

export interface DistroInfo {
  name: string
  state: string
  version: number
  isDefault: boolean
}

export interface DoctorReport {
  checks: CheckResult[]
  /** The distro we would actually use for worktrees and containers. */
  targetDistro: string | null
  /** True when every check passed. The gate for "Connect a repo". */
  ready: boolean
  /** Milliseconds the whole probe took. */
  elapsedMs: number
}
