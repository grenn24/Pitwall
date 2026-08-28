import { runDoctor } from '../doctor/index'
import { cloneRepo, createWorktree, removeWorktree } from '../workspace/index'
import { containersFor, startPreview, stopPreview } from '../preview/index'
import { hidePreview, showPreview, type PaneBounds } from '../preview/pane'
import { allTickets, loadTicket, saveTicket } from './store'
import { createTicket, run } from './index'
import type { PreviewStatus } from '../../shared/preview'
import type { Ticket } from '../../shared/ticket'
import type { BrowserWindow } from 'electron'

/**
 * What the UI asks for, and what has to happen around a run.
 *
 * A ticket needs somewhere to work before any role can start: the repository
 * cloned, a branch cut, a worktree of its own. That is §5's isolation unit, and
 * it is arranged here rather than inside the engine, which should only know
 * about states and roles.
 */

let running: AbortController | null = null

async function distro(): Promise<string> {
  const doctor = await runDoctor()
  if (!doctor.ready || !doctor.targetDistro) {
    throw new Error('This machine is not ready. Check the environment panel.')
  }
  return doctor.targetDistro
}

export interface OpenTicketInput {
  title: string
  body: string
  /** The clone URL of the repository the user picked. */
  cloneUrl: string
  repoFullName: string
}

/**
 * Create a ticket and give it somewhere to work.
 *
 * The worktree is cut before the first role starts, so every stage after this
 * has a branch of its own to commit to and nothing shared with any other
 * ticket.
 */
export async function openTicket(input: OpenTicketInput): Promise<Ticket> {
  const target = await distro()
  const { repo } = await cloneRepo(target, input.cloneUrl)

  const ticket = createTicket({ title: input.title, body: input.body, repo: input.repoFullName })
  const { worktree } = await createWorktree(target, repo, ticket.id)

  const placed: Ticket = { ...ticket, branch: worktree.branch, worktree: worktree.path }
  saveTicket(placed)
  return placed
}

/** Run a ticket to wherever it stops. Only one at a time, per §5's cap. */
export async function runTicket(id: string, onCheckpoint: (ticket: Ticket) => void): Promise<Ticket> {
  running?.abort()
  running = new AbortController()
  const target = await distro()
  try {
    return await run(id, { distro: target, onCheckpoint, signal: running.signal })
  } finally {
    running = null
  }
}

export function stopTicket(): void {
  running?.abort()
  running = null
}

/**
 * Bring up a preview for a ticket, on the worktree it already has.
 *
 * The preview belongs to the ticket rather than sitting beside it. Cutting a
 * second worktree for the same ticket — which is what the old separate panel
 * did — meant two branches, two checkouts and no way to tell which one the
 * preview was showing.
 */
const previews = new Map<string, PreviewStatus>()

export async function previewTicket(
  id: string,
  onPhase: (status: PreviewStatus) => void
): Promise<PreviewStatus> {
  const ticket = loadTicket(id)
  if (!ticket?.worktree || !ticket.branch) {
    return { phase: 'failed', env: null, error: 'This ticket has no workspace yet.' }
  }

  const target = await distro()
  const { repo } = await cloneRepo(target, `https://github.com/${ticket.repo}.git`)

  const status = await startPreview({
    distro: target,
    repo,
    worktree: { ticketId: id, branch: ticket.branch, path: ticket.worktree, headSha: '' },
    onPhase
  })

  previews.set(id, status)
  return status
}

export function previewOf(id: string): PreviewStatus | null {
  return previews.get(id) ?? null
}

export async function stopPreviewFor(id: string): Promise<{ containersLeft: string[] }> {
  const status = previews.get(id)
  hidePreview()
  if (!status?.env) return { containersLeft: [] }

  const target = await distro()
  await stopPreview(target, status.env.composePath)
  const containersLeft = await containersFor(target, status.env.project)
  previews.delete(id)
  return { containersLeft }
}

export function attachPreviewPane(window: BrowserWindow, id: string, bounds: PaneBounds): void {
  const url = previews.get(id)?.env?.url
  if (url) showPreview(window, url, bounds)
}

export function list(): Ticket[] {
  return allTickets()
}

export function get(id: string): Ticket | null {
  return loadTicket(id)
}

/**
 * Throw the ticket's workspace away.
 *
 * The clone stays: it is shared with every other ticket on the same repository
 * and re-cloning it would be pure waste.
 */
export async function discard(id: string): Promise<void> {
  const ticket = loadTicket(id)
  if (!ticket?.worktree) return
  const target = await distro()
  const { repo } = await cloneRepo(target, `https://github.com/${ticket.repo}.git`)
  await removeWorktree(target, repo, id).catch(() => undefined)
}
