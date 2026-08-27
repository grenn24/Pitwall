import { createServer } from 'node:net'

import { shellQuote, wslExec, wslExecOrThrow } from '../wsl/exec'
import { WORKSPACE_ROOT, sanitizeSegment } from '../workspace/paths'
import type { PreviewEnv, PreviewPorts, PreviewStatus } from '../../shared/preview'
import type { RepoRef, WorktreeRef } from '../../shared/workspace'
import { DEFAULT_SEED, databaseUrl, detectApp, findSeed, projectName, renderCompose } from './compose'

const ENVS_ROOT = `${WORKSPACE_ROOT}/envs`

/**
 * Ask the OS for a free port by binding zero and reading back what it gave us.
 *
 * Bound on the Windows side, which is the side that matters: Docker Desktop
 * publishes container ports onto the Windows host, so that is where a clash
 * would actually happen.
 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address && typeof address === 'object') {
        const { port } = address
        server.close(() => resolve(port))
      } else {
        server.close(() => reject(new Error('Could not allocate a port')))
      }
    })
  })
}

async function allocatePorts(): Promise<PreviewPorts> {
  // Allocated together so the two cannot collide with each other.
  const app = await freePort()
  const db = await freePort()
  return { app, db }
}

/** Poll until the app answers, or give up with a reason rather than a hang. */
async function waitForHttp(url: string, timeoutMs: number, onTick?: (waitedMs: number) => void): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3_000), redirect: 'manual' })
      // Any answer proves the server is up. A 404 at the root is still a server,
      // and plenty of apps do not serve anything at /.
      if (response.status > 0) return true
    } catch {
      // Not up yet.
    }
    onTick?.(Date.now() - started)
    await new Promise((r) => setTimeout(r, 700))
  }
  return false
}

export interface StartOptions {
  distro: string
  repo: RepoRef
  worktree: WorktreeRef
  onPhase?: (status: PreviewStatus) => void
  /** How long to wait for the app to answer before calling it failed. */
  appTimeoutMs?: number
}

/**
 * Bring up a preview environment for one ticket.
 *
 * Always returns; failures come back as a status with a phase of 'failed' and a
 * human-readable reason. A reviewer blocked by a preview that will not start
 * needs to know why, not to see a stack trace.
 */
export async function startPreview(options: StartOptions): Promise<PreviewStatus> {
  const { distro, repo, worktree, onPhase } = options
  const started = Date.now()
  const ticketId = worktree.ticketId
  const project = projectName(repo.slug, ticketId)
  const envDir = `${ENVS_ROOT}/${sanitizeSegment(repo.slug)}/${sanitizeSegment(ticketId, 'ticket')}`

  const emit = (status: PreviewStatus): PreviewStatus => {
    onPhase?.(status)
    return status
  }

  try {
    emit({ phase: 'writing-compose', env: null })

    const app = await detectApp(distro, worktree.path)
    if (app.source === 'none') {
      return emit({
        phase: 'failed',
        env: null,
        appSource: 'none',
        error:
          'This project has no Dockerfile and no compose file, so Pitwall cannot start its app. Add a Dockerfile to the repository, or connect a project that has one.',
        elapsedMs: Date.now() - started
      })
    }

    const ports = await allocatePorts()
    await wslExecOrThrow(distro, `mkdir -p ${envDir}`)

    // Resolve to a real absolute path before anything stores or quotes it.
    // These paths are built from $HOME, which survives only while a command is
    // interpolated unquoted; the moment one is passed through shellQuote the
    // literal "$HOME" reaches the shell and the path silently does not exist.
    const absEnvDir = (await wslExecOrThrow(distro, `cd ${envDir} && pwd -P`)).stdout.trim()

    // Prefer the project's own seed; fall back to ours so the database is never
    // an empty box the reviewer cannot reason about.
    const projectSeed = await findSeed(distro, worktree.path)
    const composePath = `${absEnvDir}/compose.yml`
    const seedPath = projectSeed ? `${worktree.path}/${projectSeed}` : `${absEnvDir}/seed.sql`
    if (!projectSeed) {
      await wslExecOrThrow(distro, `cat > ${shellQuote(seedPath)} <<'PITWALL_SEED_EOF'\n${DEFAULT_SEED}\nPITWALL_SEED_EOF`)
    }

    const compose = renderCompose({
      project,
      worktreePath: worktree.path,
      seedPath,
      app,
      appPort: ports.app,
      dbPort: ports.db
    })
    await wslExecOrThrow(distro, `cat > ${shellQuote(composePath)} <<'PITWALL_COMPOSE_EOF'\n${compose}\nPITWALL_COMPOSE_EOF`)

    const env: PreviewEnv = {
      ticketId,
      project,
      ports,
      url: `http://localhost:${ports.app}`,
      databaseUrl: databaseUrl(ports.db),
      composePath
    }

    emit({ phase: 'starting-database', env, appSource: app.source })
    await wslExecOrThrow(distro, `docker compose -f ${shellQuote(composePath)} up -d db --wait`, 240_000)

    emit({ phase: 'building-app', env, appSource: app.source })
    const up = await wslExec(distro, `docker compose -f ${shellQuote(composePath)} up -d app`, 900_000)
    if (up.code !== 0) {
      const reason = (up.stderr || up.stdout).trim().split('\n').slice(-6).join('\n')
      await stopPreview(distro, composePath)
      return emit({
        phase: 'failed',
        env,
        appSource: app.source,
        error: `The app container failed to build or start.\n\n${reason}`,
        elapsedMs: Date.now() - started
      })
    }

    emit({ phase: 'waiting-for-app', env, appSource: app.source })
    const alive = await waitForHttp(env.url, options.appTimeoutMs ?? 120_000)
    if (!alive) {
      const logs = await wslExec(distro, `docker compose -f ${shellQuote(composePath)} logs --tail 20 app`)
      return emit({
        phase: 'failed',
        env,
        appSource: app.source,
        error: `The app container started but never answered on port ${app.port}.\n\n${logs.stdout.trim().split('\n').slice(-10).join('\n')}`,
        elapsedMs: Date.now() - started
      })
    }

    return emit({ phase: 'ready', env, appSource: app.source, elapsedMs: Date.now() - started })
  } catch (error) {
    return emit({
      phase: 'failed',
      env: null,
      error: error instanceof Error ? error.message : String(error),
      elapsedMs: Date.now() - started
    })
  }
}

/**
 * Tear an environment down completely.
 *
 * `--volumes --remove-orphans` because M0's exit criteria says nothing is left
 * behind, and a stray named volume is exactly the kind of leftover that only
 * shows up as a disk-space complaint two weeks later.
 */
export async function stopPreview(distro: string, composePath: string): Promise<void> {
  await wslExec(distro, `docker compose -f ${shellQuote(composePath)} down --volumes --remove-orphans`, 180_000)
}

/** Containers currently running for a project. Used to verify teardown. */
export async function containersFor(distro: string, project: string): Promise<string[]> {
  const { stdout } = await wslExec(
    distro,
    `docker ps -a --filter label=com.docker.compose.project=${shellQuote(project)} --format '{{.Names}}'`
  )
  return stdout.trim().split(/\r?\n/).filter(Boolean)
}

export { ENVS_ROOT }
