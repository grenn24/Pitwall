import { runDoctor } from '../doctor/index'
import { cloneRepo, createWorktree, removeWorktree } from '../workspace/index'
import { allTickets, loadTicket, saveTicket } from './store'
import { createTicket, run } from './index'
import type { Ticket } from '../../shared/ticket'

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
