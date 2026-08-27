import { BrowserWindow } from 'electron'

import { runDoctor } from './doctor/index'
import { cloneRepo, createWorktree, removeWorktree } from './workspace/index'
import { containersFor, startPreview, stopPreview } from './preview/index'
import { hidePreview, showPreview, type PaneBounds } from './preview/pane'
import type { RepoRef, WorktreeRef } from '../shared/workspace'
import type { PreviewStatus } from '../shared/preview'

/**
 * The one ticket v0 can have open at a time, and everything attached to it.
 *
 * Deliberately not a store or a state machine. That arrives in M2, where it is
 * the milestone rather than a detail; until then a single mutable record is
 * enough and is honest about what v0 supports.
 */
interface Session {
  distro: string
  repo: RepoRef
  worktree: WorktreeRef
  status: PreviewStatus
}

let session: Session | null = null

export interface OpenTicketInput {
  remoteUrl: string
  ticketId: string
}

/** Clone, cut a worktree, and bring up a preview. Reports progress as it goes. */
export async function openTicket(
  input: OpenTicketInput,
  onPhase: (status: PreviewStatus) => void
): Promise<PreviewStatus> {
  await closeTicket()

  const doctor = await runDoctor()
  if (!doctor.ready || !doctor.targetDistro) {
    return { phase: 'failed', env: null, error: 'This machine is not ready. Check the environment panel and try again.' }
  }
  const distro = doctor.targetDistro

  const { repo } = await cloneRepo(distro, input.remoteUrl)
  const { worktree } = await createWorktree(distro, repo, input.ticketId)

  const status = await startPreview({ distro, repo, worktree, onPhase })
  session = { distro, repo, worktree, status }
  return status
}

/** Tear everything down: containers, volumes, worktree, branch, preview pane. */
export async function closeTicket(): Promise<{ containersLeft: string[] } | null> {
  if (!session) return null
  const { distro, repo, worktree, status } = session

  hidePreview()
  if (status.env) await stopPreview(distro, status.env.composePath)
  await removeWorktree(distro, repo, worktree.ticketId)

  const containersLeft = status.env ? await containersFor(distro, status.env.project) : []
  session = null
  return { containersLeft }
}

export function currentStatus(): PreviewStatus | null {
  return session?.status ?? null
}

export function attachPreview(window: BrowserWindow, bounds: PaneBounds): void {
  const url = session?.status.env?.url
  if (url) showPreview(window, url, bounds)
}
