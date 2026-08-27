import { shellQuote, wslExec, wslExecOrThrow } from '../wsl/exec'
import type { CloneResult, FilesystemCheck, RepoRef, WorktreeRef, WorktreeResult, Timing } from '../../shared/workspace'
import { REPOS_ROOT, WORKTREES_ROOT, branchName, repoPath, slugFromRemote, worktreePath } from './paths'

/**
 * Repository and worktree operations, all executed inside the distro.
 *
 * Nothing here touches the Windows filesystem. A clone on C: mounted through
 * /mnt is roughly an order of magnitude slower for the many-small-files work
 * that git and node_modules both do, and it is where the file-watching problems
 * come from. Keeping every path native is the whole point of the WSL2 decision.
 */

export async function ensureWorkspace(distro: string): Promise<void> {
  await wslExecOrThrow(distro, `mkdir -p ${REPOS_ROOT} ${WORKTREES_ROOT}`)
}

/**
 * Confirm the workspace root is on a real Linux filesystem.
 *
 * Cheap insurance against a misconfigured distro where $HOME has been pointed at
 * a Windows drive. When that happens everything still works and everything is
 * slow, which is the worst way for a performance problem to present.
 */
export async function checkFilesystem(distro: string): Promise<FilesystemCheck> {
  const { stdout } = await wslExecOrThrow(
    distro,
    `mkdir -p ${REPOS_ROOT} && cd ${REPOS_ROOT} && printf '%s\\n%s\\n' "$(pwd -P)" "$(stat -f -c %T .)"`
  )
  const [root = '', fsType = 'unknown'] = stdout.trim().split(/\r?\n/)
  return { root, fsType: fsType.trim(), isNative: !root.startsWith('/mnt/') && fsType.trim() !== '9p' }
}

/**
 * Clone a repository into the distro, or reuse an existing clone.
 *
 * Reuse rather than re-clone: a second connect of the same repo should be
 * instant, and re-cloning would throw away objects the next worktree needs.
 */
export async function cloneRepo(distro: string, remoteUrl: string, onProgress?: (line: string) => void): Promise<CloneResult> {
  const timings: Timing[] = []
  const slug = slugFromRemote(remoteUrl)
  const path = repoPath(slug)

  await ensureWorkspace(distro)

  const existing = await wslExec(distro, `test -d ${path}/.git && echo yes || echo no`)
  const reused = existing.stdout.trim() === 'yes'

  if (reused) {
    onProgress?.(`Reusing existing clone at ${path}`)
    const fetch = await wslExecOrThrow(distro, `cd ${path} && git fetch --all --prune`, 180_000)
    timings.push({ label: 'fetch', ms: fetch.elapsedMs })
  } else {
    onProgress?.(`Cloning ${remoteUrl}`)
    // --filter=blob:none keeps history and branches while deferring file content
    // until something asks for it. On a large repository this is the difference
    // between a connect that feels instant and one that looks broken.
    const clone = await wslExecOrThrow(
      distro,
      `git clone --filter=blob:none ${shellQuote(remoteUrl)} ${path}`,
      600_000
    )
    timings.push({ label: 'clone', ms: clone.elapsedMs })
  }

  const info = await wslExecOrThrow(
    distro,
    `cd ${path} && printf '%s\\n%s\\n' "$(git symbolic-ref --short HEAD)" "$(git rev-parse HEAD)"`
  )
  const [defaultBranch = '', headSha = ''] = info.stdout.trim().split(/\r?\n/)

  const resolved = await wslExecOrThrow(distro, `cd ${path} && pwd -P`)

  const repo: RepoRef = {
    slug,
    path: resolved.stdout.trim(),
    remoteUrl,
    defaultBranch: defaultBranch.trim(),
    headSha: headSha.trim()
  }

  return { repo, timings, reused }
}

/**
 * Cut a worktree for one ticket.
 *
 * One ticket, one branch, one worktree — the isolation unit from §5 of the spec.
 * Branching from the remote's default rather than from whatever the clone
 * happens to have checked out, so a ticket never inherits another ticket's work.
 */
export async function createWorktree(
  distro: string,
  repo: RepoRef,
  ticketId: string,
  baseBranch?: string
): Promise<WorktreeResult> {
  const timings: Timing[] = []
  const branch = branchName(ticketId)
  const path = worktreePath(repo.slug, ticketId)
  const base = baseBranch ?? repo.defaultBranch

  await wslExecOrThrow(distro, `mkdir -p ${WORKTREES_ROOT}/${repo.slug}`)

  const add = await wslExecOrThrow(
    distro,
    `cd ${repo.path} && git worktree add -b ${shellQuote(branch)} ${path} ${shellQuote(`origin/${base}`)}`,
    180_000
  )
  timings.push({ label: 'worktree add', ms: add.elapsedMs })

  // Line endings are set per worktree rather than relying on the user's global
  // git config, because a CRLF checkout inside a Linux container fails in ways
  // that look nothing like a line-ending problem.
  await wslExecOrThrow(distro, `cd ${path} && git config core.autocrlf false && git config core.fileMode false`)

  const sha = await wslExecOrThrow(distro, `cd ${path} && git rev-parse HEAD`)
  const resolved = await wslExecOrThrow(distro, `cd ${path} && pwd -P`)

  const worktree: WorktreeRef = {
    ticketId,
    branch,
    path: resolved.stdout.trim(),
    headSha: sha.stdout.trim()
  }

  return { worktree, timings }
}

/** Every worktree currently cut from this clone, parsed from git's porcelain output. */
export async function listWorktrees(distro: string, repo: RepoRef): Promise<WorktreeRef[]> {
  const { stdout } = await wslExecOrThrow(distro, `cd ${repo.path} && git worktree list --porcelain`)
  const worktrees: WorktreeRef[] = []

  let current: Partial<WorktreeRef> & { path?: string } = {}
  const flush = (): void => {
    if (current.path && current.branch && !current.path.endsWith(`/${repo.slug}`)) {
      worktrees.push({
        ticketId: current.branch.replace(/^pitwall\//, ''),
        branch: current.branch,
        path: current.path,
        headSha: current.headSha ?? ''
      })
    }
    current = {}
  }

  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      flush()
      current.path = line.slice('worktree '.length).trim()
    } else if (line.startsWith('HEAD ')) {
      current.headSha = line.slice('HEAD '.length).trim()
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '')
    }
  }
  flush()

  return worktrees
}

/**
 * Tear down a worktree and its branch.
 *
 * M0's exit criteria says teardown leaves nothing behind, so this also prunes
 * git's administrative records — without that, `git worktree list` keeps naming
 * directories that no longer exist.
 */
export async function removeWorktree(distro: string, repo: RepoRef, ticketId: string): Promise<Timing[]> {
  const timings: Timing[] = []
  const path = worktreePath(repo.slug, ticketId)
  const branch = branchName(ticketId)

  const remove = await wslExec(distro, `cd ${repo.path} && git worktree remove --force ${path}`, 60_000)
  timings.push({ label: 'worktree remove', ms: remove.elapsedMs })

  await wslExec(distro, `cd ${repo.path} && git worktree prune`)
  await wslExec(distro, `cd ${repo.path} && git branch -D ${shellQuote(branch)}`)
  await wslExec(distro, `rm -rf ${path}`)

  return timings
}
