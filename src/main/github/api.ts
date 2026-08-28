import { fetchOrExplain } from './auth'
import type { BranchStatus, Repo } from '../../shared/github'

/**
 * The GitHub REST calls Pitwall makes.
 *
 * Every one of them is scoped by the App's installation, which is the point of
 * §7: an org admin decides which repositories this can touch, and a repository
 * that was not granted is not merely forbidden — it does not appear at all.
 *
 * Read-only apart from the pull request work in M8. Nothing here bypasses
 * branch protection or CODEOWNERS, and nothing here is meant to.
 */

const API = 'https://api.github.com'

export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
    this.name = 'GitHubApiError'
  }
}

async function get<T>(token: string, path: string): Promise<T> {
  const response = await fetchOrExplain(`${API}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    signal: AbortSignal.timeout(20_000)
  }, `read ${path.split('?')[0]}`)

  if (response.status === 401) {
    // The one failure worth naming: a revoked or expired token. Everything
    // upstream should treat this as "sign in again", not as an outage.
    throw new GitHubApiError('This sign-in is no longer valid. Sign in again.', 401)
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { message?: string }
    throw new GitHubApiError(body.message ?? `GitHub returned ${response.status}.`, response.status)
  }

  return (await response.json()) as T
}

export interface Viewer {
  login: string
  name: string | null
  avatarUrl: string | null
}

export async function getViewer(token: string): Promise<Viewer> {
  const user = await get<{ login: string; name: string | null; avatar_url: string | null }>(token, '/user')
  return { login: user.login, name: user.name, avatarUrl: user.avatar_url }
}

export interface Installation {
  id: number
  account: string
  /** 'all' when the user granted every repository, 'selected' otherwise. */
  repositorySelection: string
}

/** Where this App has been installed, from the signed-in user's point of view. */
export async function listInstallations(token: string): Promise<Installation[]> {
  const body = await get<{
    installations: { id: number; account: { login: string } | null; repository_selection: string }[]
  }>(token, '/user/installations?per_page=100')

  return body.installations.map((i) => ({
    id: i.id,
    account: i.account?.login ?? '(unknown)',
    repositorySelection: i.repository_selection
  }))
}

/**
 * The repositories this installation may touch.
 *
 * Not "the user's repositories". A repository the App was not granted is
 * absent from this list rather than present and failing later, which is the
 * behaviour §7 promises to org admins.
 */
export async function listRepos(token: string, installationId: number): Promise<Repo[]> {
  const body = await get<{
    repositories: {
      full_name: string
      clone_url: string
      default_branch: string
      private: boolean
      pushed_at: string | null
    }[]
  }>(token, `/user/installations/${installationId}/repositories?per_page=100`)

  return body.repositories.map((r) => ({
    fullName: r.full_name,
    cloneUrl: r.clone_url,
    defaultBranch: r.default_branch,
    private: r.private,
    updatedAt: r.pushed_at
  }))
}

/**
 * What the project's own CI says about a branch.
 *
 * Read-only, per §8: production deploys belong to whatever pipeline the team
 * already has, and Pitwall's job is to show what it reports rather than to run
 * anything itself.
 */
export async function getBranchStatus(token: string, fullName: string, ref: string): Promise<BranchStatus> {
  const runs = await get<{
    check_runs: { name: string; status: string; conclusion: string | null; html_url: string | null }[]
  }>(token, `/repos/${fullName}/commits/${encodeURIComponent(ref)}/check-runs?per_page=20`).catch((error) => {
    // A repository with no checks configured answers 404 here, which is an
    // absence rather than a failure.
    if (error instanceof GitHubApiError && error.status === 404) return { check_runs: [] }
    throw error
  })

  const checks = runs.check_runs.map((run) => ({
    name: run.name,
    state: run.conclusion ?? run.status,
    url: run.html_url
  }))

  const state = rollUp(checks.map((c) => c.state))

  const deployments = await get<{ id: number; environment: string }[]>(
    token,
    `/repos/${fullName}/deployments?ref=${encodeURIComponent(ref)}&per_page=1`
  ).catch(() => [])

  let deployment: BranchStatus['deployment'] = null
  if (deployments.length > 0) {
    const statuses = await get<{ state: string; environment_url: string | null }[]>(
      token,
      `/repos/${fullName}/deployments/${deployments[0].id}/statuses?per_page=1`
    ).catch(() => [])
    deployment = {
      environment: deployments[0].environment,
      state: statuses[0]?.state ?? 'unknown',
      url: statuses[0]?.environment_url ?? null
    }
  }

  return { state, checks, deployment }
}

/** One verdict from many checks: anything failing loses, anything pending waits. */
function rollUp(states: string[]): BranchStatus['state'] {
  if (states.length === 0) return null
  if (states.some((s) => s === 'failure' || s === 'timed_out' || s === 'cancelled')) return 'failure'
  if (states.some((s) => s === 'queued' || s === 'in_progress')) return 'pending'
  if (states.every((s) => s === 'success' || s === 'neutral' || s === 'skipped')) return 'success'
  return 'neutral'
}
