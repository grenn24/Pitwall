import { saveTicket } from './store'
import type { Checkpoint, RoleId, Ticket, TicketState } from '../../shared/ticket'

/**
 * The state machine.
 *
 * §4 Rule 4: the run engine owns handoff. An agent finishes its turn and stops;
 * this decides whether the ticket moves, based on whether the artifacts that
 * stage was meant to produce actually exist. No agent calls `advance`.
 *
 * Every transition is written to disk before the next one begins. That is what
 * makes a crash survivable: the worst case is repeating one stage, never losing
 * the run.
 */

/** Which state may follow which. Anything absent is refused. */
const ALLOWED: Record<TicketState, TicketState[]> = {
  draft: ['planning', 'failed'],
  planning: ['spec_ready', 'failed'],
  spec_ready: ['writing_tests', 'failed'],
  writing_tests: ['tests_written', 'failed'],
  tests_written: ['writing_code', 'failed'],
  writing_code: ['code_complete', 'failed'],
  code_complete: ['reviewing', 'failed'],
  reviewing: ['review_passed', 'changes_requested', 'failed'],
  // A send-back re-enters at the implementation stage rather than the start.
  // The spec and the tests are still good; it is the code that was wrong.
  changes_requested: ['writing_code', 'failed'],
  review_passed: ['done', 'changes_requested', 'failed'],
  done: [],
  failed: ['draft']
}

export class IllegalTransition extends Error {
  constructor(from: TicketState, to: TicketState) {
    super(`A ticket cannot go from ${from} to ${to}.`)
    this.name = 'IllegalTransition'
  }
}

export function canAdvance(from: TicketState, to: TicketState): boolean {
  return ALLOWED[from].includes(to)
}

/**
 * Move a ticket, and write it down before anything else happens.
 *
 * Returns the updated ticket rather than mutating in place, so a caller holding
 * a stale copy cannot silently keep using it.
 */
export function advance(ticket: Ticket, to: TicketState, note: string, role?: RoleId): Ticket {
  if (!canAdvance(ticket.state, to)) throw new IllegalTransition(ticket.state, to)

  const checkpoint: Checkpoint = {
    at: new Date().toISOString(),
    from: ticket.state,
    to,
    role,
    note
  }

  const next: Ticket = {
    ...ticket,
    state: to,
    updatedAt: checkpoint.at,
    checkpoints: [...ticket.checkpoints, checkpoint]
  }

  // Persisted here, not by the caller. A transition that is not on disk did not
  // happen, and leaving that to whoever calls this invites the one code path
  // that forgets.
  saveTicket(next)
  return next
}

export function fail(ticket: Ticket, error: string): Ticket {
  const next: Ticket = {
    ...ticket,
    state: 'failed',
    error,
    updatedAt: new Date().toISOString(),
    checkpoints: [
      ...ticket.checkpoints,
      { at: new Date().toISOString(), from: ticket.state, to: 'failed', note: error }
    ]
  }
  saveTicket(next)
  return next
}

/**
 * Where a resumed run should pick up.
 *
 * A ticket caught mid-stage goes back to the state that stage started from, so
 * the stage runs again from a known point. Repeating work is cheap; guessing
 * how far a killed process got is not.
 */
export function resumeState(state: TicketState): TicketState {
  switch (state) {
    case 'planning':
      return 'draft'
    case 'writing_tests':
      return 'spec_ready'
    case 'writing_code':
      return 'tests_written'
    case 'reviewing':
      return 'code_complete'
    default:
      return state
  }
}
