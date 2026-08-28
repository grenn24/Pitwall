import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { Refusal, Ticket } from '../../shared/ticket'

/**
 * Durable storage for tickets and their checkpoints.
 *
 * The plan says SQLite. This is JSON, deliberately, and the reason is worth
 * recording: v0 runs one ticket at a time, so there is nothing to query and
 * nothing to contend over, and SQLite means a native module that has to be
 * rebuilt against Electron on every version bump. The moment v1 runs tickets
 * concurrently, that changes and this becomes the wrong choice.
 *
 * What matters here is not the format but that a write either happens
 * completely or not at all. A checkpoint half-written during a crash is worse
 * than no checkpoint, because resuming would trust it.
 */

const ROOT = join(homedir(), '.pitwall', 'tickets')

function pathFor(id: string): string {
  return join(ROOT, `${id}.json`)
}

/**
 * Write through a temporary file and rename over the target.
 *
 * Rename is atomic on the same volume, so a reader either sees the previous
 * state or the new one, never a partial file — which is the property the
 * resume-after-crash criterion actually depends on.
 */
function writeAtomic(path: string, contents: string): void {
  mkdirSync(ROOT, { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, contents, 'utf8')
  renameSync(temp, path)
}

export function saveTicket(ticket: Ticket): void {
  writeAtomic(pathFor(ticket.id), JSON.stringify(ticket, null, 2))
}

export function loadTicket(id: string): Ticket | null {
  try {
    const path = pathFor(id)
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf8')) as Ticket
  } catch {
    // A corrupt record is treated as absent. Refusing to start because one
    // ticket file is unreadable would take the whole app down with it.
    return null
  }
}

/**
 * Remove a ticket record.
 *
 * Exists for the test harness, which shares this store with the app. Six of its
 * tickets once turned up in the user's list, which is a good argument for a
 * harness cleaning up after itself.
 */
export function deleteTicket(id: string): void {
  try {
    const path = pathFor(id)
    if (existsSync(path)) unlinkSync(path)
  } catch {
    // A record that will not delete is not worth failing over.
  }
}

export function allTickets(): Ticket[] {
  try {
    if (!existsSync(ROOT)) return []
    return readdirSync(ROOT)
      .filter((f) => f.endsWith('.json'))
      .map((f) => loadTicket(f.replace(/\.json$/, '')))
      .filter((t): t is Ticket => t !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  } catch {
    return []
  }
}

/**
 * Refused tool calls, kept separately from the tickets.
 *
 * A refusal is evidence about the system rather than about the ticket: it says
 * a role tried to do something its permissions forbid. Worth keeping even when
 * the ticket it happened on is long gone.
 */
const REFUSALS = join(homedir(), '.pitwall', 'refusals.json')

export function recordRefusal(refusal: Refusal): void {
  try {
    const existing = readRefusals()
    existing.push(refusal)
    mkdirSync(join(homedir(), '.pitwall'), { recursive: true })
    writeAtomic(REFUSALS, JSON.stringify(existing.slice(-200), null, 2))
  } catch {
    // Never let bookkeeping break a run.
  }
}

export function readRefusals(): Refusal[] {
  try {
    if (!existsSync(REFUSALS)) return []
    return JSON.parse(readFileSync(REFUSALS, 'utf8')) as Refusal[]
  } catch {
    return []
  }
}

export { ROOT as TICKETS_ROOT }
