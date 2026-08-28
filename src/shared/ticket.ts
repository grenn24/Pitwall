/**
 * A ticket and the states it moves through.
 *
 * The state machine is the product's spine. §4 Rule 4: agents do not decide
 * when they are done — the run engine moves a ticket forward when the artifacts
 * that stage was supposed to produce exist and its checks pass. An agent that
 * could declare itself finished and summon the next one would be message
 * passing with extra steps, and Rule 1 would quietly stop holding.
 */

export type TicketState =
  /** Written, not started. */
  | 'draft'
  /** The Designer is establishing what this means. */
  | 'planning'
  /** The ticket document has a spec the next role can work from. */
  | 'spec_ready'
  /** Tests are being written, from the ticket, before any implementation. */
  | 'writing_tests'
  /** Tests exist and fail. §4 Rule 3: they must fail before there is code. */
  | 'tests_written'
  /** The Coder is implementing against those tests. */
  | 'writing_code'
  /** Code is committed on the branch. */
  | 'code_complete'
  /** The Reviewer is running the suite and opening the app. */
  | 'reviewing'
  /** The Reviewer is satisfied. Waiting for the human. */
  | 'review_passed'
  /** The Reviewer or the human sent it back, with a reason. */
  | 'changes_requested'
  /** Merged and torn down. */
  | 'done'
  /** Stopped, with a reason. */
  | 'failed'

/** States where work is in flight and a crash should resume. */
export const RUNNING_STATES: TicketState[] = ['planning', 'writing_tests', 'writing_code', 'reviewing']

/** States where nothing more happens without a person. */
export const TERMINAL_STATES: TicketState[] = ['done', 'failed', 'review_passed', 'changes_requested']

export type RoleId = 'designer' | 'test-writer' | 'coder' | 'reviewer'

/**
 * One transition, recorded as it happens.
 *
 * The record is append-only. A run that is resumed after a crash reads these
 * to know where it was, and a human reading them afterwards can see which role
 * did what and when — which a conversation log cannot tell them.
 */
export interface Checkpoint {
  at: string
  from: TicketState
  to: TicketState
  /** Which role's work caused this, when a role caused it. */
  role?: RoleId
  /** Why, in a sentence. Shown in the UI and in the ticket document. */
  note: string
}

export interface Ticket {
  id: string
  /** What the user wrote. The source of truth every role reads. */
  title: string
  body: string
  state: TicketState
  /** owner/name of the repository this belongs to. */
  repo: string
  /** Branch cut for this ticket, once there is one. */
  branch: string | null
  /** Absolute path of the worktree inside the distribution, once there is one. */
  worktree: string | null
  createdAt: string
  updatedAt: string
  /** Every transition, oldest first. */
  checkpoints: Checkpoint[]
  /** Present when state is 'failed'. */
  error?: string
  /** Tokens and cost, accumulated. Zero until M3 spends anything. */
  cost: { tokensIn: number; tokensOut: number; usd: number }
}

/** A tool call that was refused, kept so the UI can show what was attempted. */
export interface Refusal {
  role: RoleId
  tool: string
  at: string
  reason: string
}
