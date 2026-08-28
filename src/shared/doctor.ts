/**
 * The environment probe that gates everything else.
 *
 * Pitwall runs its worktrees and containers inside WSL2, so before any repo can
 * be connected the machine has to actually have WSL2, a usable Linux distro, and
 * a Docker daemon reachable from inside that distro. This module answers that,
 * and when the answer is no, says what to do about it.
 */

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'checking' | 'pending'

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
  /**
   * The exact command to run, when the fix is one.
   *
   * Separate from `remediation` so the UI can offer to copy it. Retyping a
   * command from a screenshot is where typos come from, and on a fresh machine
   * that is exactly what someone is doing.
   */
  command?: string
  /**
   * Which entry in main's command table repairs this. The renderer sends this
   * id to ask for it and never a command, so the table stays in main.
   *
   * Separate from the check id because one check can fail in ways that need
   * different fixes — Docker missing and Docker stopped are not the same
   * problem and do not have the same answer.
   */
  fixId?: FixId
  /** True when Pitwall can run the fix itself. */
  canFix?: boolean
  /** True when running it will raise a Windows permission prompt. */
  fixElevated?: boolean
  /** What to show while the fix runs, for commands that print little. */
  fixWhileRunning?: string
  /** Raw output, kept for the log pane. Never shown by default. */
  raw?: string
}

export type CheckId = 'wsl' | 'distro' | 'git' | 'docker' | 'compose'

export type FixId =
  | 'restart-windows'
  | 'wsl-install'
  | 'wsl-default-v2'

export interface DistroInfo {
  name: string
  state: string
  version: number
  isDefault: boolean
}

export interface FixOutcome {
  ok: boolean
  /**
   * True when the command was launched but is still waiting on the user, in a
   * window of its own. The UI should keep watching rather than declare victory.
   */
  pending?: boolean
  /**
   * True when the machine must restart before the change takes effect.
   *
   * Without this the UI re-probes, correctly finds nothing changed yet, and
   * shows the same blocked row — which reads as the fix having done nothing.
   */
  needsRestart?: boolean
  /** What to expect next, on success. */
  afterward?: string
  /** Why it did not run, on failure. Written for a human. */
  error?: string
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
