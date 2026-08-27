/**
 * Wire types for the workspace layer: the clone that backs a repo, and the
 * per-ticket worktrees cut from it.
 */

export interface RepoRef {
  /** Directory name under the repos root. Derived from the remote, sanitized. */
  slug: string
  /** Absolute path inside the distro. Always on ext4, never under /mnt. */
  path: string
  remoteUrl: string
  defaultBranch: string
  headSha: string
}

export interface WorktreeRef {
  /** The ticket this worktree belongs to. One ticket, one worktree, one branch. */
  ticketId: string
  branch: string
  /** Absolute path inside the distro. */
  path: string
  headSha: string
}

/**
 * Timings for one workspace operation.
 *
 * Kept on every result rather than logged and forgotten: WSL2 filesystem
 * performance is the headline risk in the build plan, and the only way that
 * risk gets retired is with numbers from real repositories.
 */
export interface Timing {
  label: string
  ms: number
}

export interface CloneResult {
  repo: RepoRef
  timings: Timing[]
  /** True when the clone was already present and was reused. */
  reused: boolean
}

export interface WorktreeResult {
  worktree: WorktreeRef
  timings: Timing[]
}

export interface FilesystemCheck {
  /** Where the workspace root resolves inside the distro. */
  root: string
  /**
   * False when the root sits under /mnt — a Windows drive mounted into Linux,
   * which is the slow path this whole architecture exists to avoid.
   */
  isNative: boolean
  /** Filesystem type reported by the distro, e.g. ext4 or 9p. */
  fsType: string
}
