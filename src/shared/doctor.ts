/**
 * The environment probe that gates everything else.
 *
 * Pitwall runs its worktrees and containers inside WSL2, so before any repo can
 * be connected the machine has to actually have WSL2, a usable Linux distro, and
 * a Docker daemon reachable from inside that distro. This module answers that,
 * and when the answer is no, says what to do about it.
 */

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'checking'

export interface CheckResult {
  /** Stable id, used by the UI and by tests. */
  id: CheckId
  /** Human label, shown in the first-run screen. */
  label: string
  status: CheckStatus
  /** What we found. Shown under the label. Always concrete — a version, a name, a reason. */
  detail: string
  /** What the user should do about it. Present only when status is not 'ok'. */
  remediation?: string
  /** A URL the user can open to fix it, when one genuinely helps. */
  docsUrl?: string
  /** Raw output, kept for the log pane. Never shown by default. */
  raw?: string
}

export type CheckId = 'wsl' | 'wslVersion' | 'distro' | 'docker' | 'compose'

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
  /** Milliseconds the whole probe took. M0 exit criteria says measure this. */
  elapsedMs: number
}
