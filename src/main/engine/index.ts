import { randomUUID } from 'node:crypto'

import { AGENTS } from './agents'
import { advance, fail, resumeState } from './machine'
import { loadTicket, saveTicket } from './store'
import type { ToolContext } from './tools'
import type { RoleId, Ticket, TicketState } from '../../shared/ticket'

/**
 * The run engine.
 *
 * Reads a ticket's state, runs the one role that state calls for, and moves the
 * ticket on if that role produced what the next stage needs. Nothing else
 * decides when a ticket advances — §4 Rule 4.
 *
 * Every stage is bounded by two writes to disk: the state that started it, and
 * the state that follows. Killing the process at any moment loses at most the
 * stage in flight, which is repeated on resume.
 */

/** Which role owns which state, and what a completed stage means. */
const STAGES: Partial<Record<TicketState, { role: RoleId; running: TicketState; done: TicketState }>> = {
  draft: { role: 'designer', running: 'planning', done: 'spec_ready' },
  spec_ready: { role: 'test-writer', running: 'writing_tests', done: 'tests_written' },
  tests_written: { role: 'coder', running: 'writing_code', done: 'code_complete' },
  changes_requested: { role: 'coder', running: 'writing_code', done: 'code_complete' },
  code_complete: { role: 'reviewer', running: 'reviewing', done: 'review_passed' }
}

export interface RunOptions {
  distro: string
  /** Called after every transition, so a UI can follow along. */
  onCheckpoint?: (ticket: Ticket) => void
  /** Stop before starting the stage that owns this state. Used by the tests. */
  stopBefore?: TicketState
  signal?: AbortSignal
}

export function createTicket(input: { title: string; body: string; repo: string }): Ticket {
  const now = new Date().toISOString()
  const ticket: Ticket = {
    id: randomUUID().slice(0, 8),
    title: input.title,
    body: input.body,
    state: 'draft',
    repo: input.repo,
    branch: null,
    worktree: null,
    createdAt: now,
    updatedAt: now,
    checkpoints: [],
    cost: { tokensIn: 0, tokensOut: 0, usd: 0 }
  }
  saveTicket(ticket)
  return ticket
}

/**
 * Bring a ticket back to a state a stage can start from.
 *
 * A ticket caught mid-stage by a crash or a sleeping laptop is rewound to where
 * that stage began. The alternative — guessing how far the killed process got —
 * is how a resumed run ends up with half a stage's work and no way to tell.
 */
export function resume(ticket: Ticket): Ticket {
  const rewound = resumeState(ticket.state)
  if (rewound === ticket.state) return ticket

  const at = new Date().toISOString()
  const next: Ticket = {
    ...ticket,
    state: rewound,
    updatedAt: at,
    checkpoints: [
      ...ticket.checkpoints,
      { at, from: ticket.state, to: rewound, note: 'Resumed after an interrupted run; repeating this stage' }
    ]
  }
  saveTicket(next)
  return next
}

/**
 * Run a ticket until it needs a person, fails, or is asked to stop.
 *
 * Returns the ticket in whatever state it reached. Never throws for ordinary
 * failures — a run that stopped because a stage did not produce its artifact is
 * a result, not an exception.
 */
export async function run(ticketId: string, options: RunOptions): Promise<Ticket> {
  let ticket = loadTicket(ticketId)
  if (!ticket) throw new Error(`No ticket ${ticketId}.`)

  ticket = resume(ticket)
  options.onCheckpoint?.(ticket)

  while (true) {
    if (options.signal?.aborted) return ticket
    if (options.stopBefore && ticket.state === options.stopBefore) return ticket

    const stage = STAGES[ticket.state]
    if (!stage) return ticket

    ticket = advance(ticket, stage.running, `${stage.role} started`, stage.role)
    options.onCheckpoint?.(ticket)

    const ctx: ToolContext = { distro: options.distro, ticket }

    try {
      const result = await AGENTS[stage.role](ctx)

      if (!result.produced) {
        // The stage ran and decided the work is not right. That is a verdict,
        // not a crash, and for the reviewer it is the entire job.
        ticket = advance(ticket, 'changes_requested', result.note, stage.role)
        options.onCheckpoint?.(ticket)
        return ticket
      }

      ticket = advance(ticket, stage.done, result.note, stage.role)
      options.onCheckpoint?.(ticket)
    } catch (error) {
      ticket = fail(ticket, error instanceof Error ? error.message : String(error))
      options.onCheckpoint?.(ticket)
      return ticket
    }
  }
}

export { loadTicket, allTickets } from './store'
export { readRefusals } from './store'
