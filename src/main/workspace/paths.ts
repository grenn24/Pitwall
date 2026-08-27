/**
 * Where things live inside the distro, and how names are made safe.
 *
 * Everything sits under a single root in the user's Linux home directory. That
 * is deliberate: it is ext4, it is not visible to Windows indexing or antivirus,
 * and it can be removed in one command when a user uninstalls.
 */

export const WORKSPACE_ROOT = '$HOME/.pitwall'
export const REPOS_ROOT = `${WORKSPACE_ROOT}/repos`
export const WORKTREES_ROOT = `${WORKSPACE_ROOT}/worktrees`

/** Branch prefix, so our branches are obvious in `git branch` and easy to prune. */
export const BRANCH_PREFIX = 'pitwall'

/**
 * Turn arbitrary text into something safe as a single path segment.
 *
 * Conservative on purpose. These values reach a shell command and a git ref, and
 * both have their own opinions about punctuation — git in particular rejects
 * refs containing `..`, a trailing `.lock`, or a leading dash.
 */
export function sanitizeSegment(input: string, fallback = 'repo'): string {
  const cleaned = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 64)
    .replace(/\.lock$/, '-lock')

  return cleaned.length > 0 ? cleaned : fallback
}

/**
 * Derive a directory name from a git remote.
 *
 * `https://github.com/grenn24/Pitwall.git` becomes `grenn24-pitwall`, which
 * keeps two repos of the same name from different owners apart.
 */
export function slugFromRemote(remoteUrl: string): string {
  const withoutSuffix = remoteUrl.replace(/\.git\/?$/, '').replace(/\/+$/, '')
  const parts = withoutSuffix.split(/[/:]/).filter(Boolean)
  const tail = parts.slice(-2)
  return sanitizeSegment(tail.join('-'))
}

export function repoPath(slug: string): string {
  return `${REPOS_ROOT}/${slug}`
}

export function worktreePath(slug: string, ticketId: string): string {
  return `${WORKTREES_ROOT}/${slug}/${sanitizeSegment(ticketId, 'ticket')}`
}

export function branchName(ticketId: string): string {
  return `${BRANCH_PREFIX}/${sanitizeSegment(ticketId, 'ticket')}`
}
