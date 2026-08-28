import type { RoleId } from '../../shared/ticket'

/**
 * Roles, and what each one is allowed to touch.
 *
 * The permissions here are enforced by the tool layer, not by prompts. §4 Rule 2
 * depends on it: a Reviewer that could edit code would eventually edit code,
 * whatever its instructions said, and a reviewer who can fix what they find is
 * no longer reviewing. A prompt-enforced boundary is not a boundary — it is a
 * request.
 */

export type ToolId =
  /** Read any file in the worktree. */
  | 'read_file'
  /** Create or modify a file in the worktree. */
  | 'write_file'
  /** Create or modify a file under the project's test directories. */
  | 'write_test'
  /** Commit what is in the worktree. */
  | 'commit'
  /** Run the project's test command and read the result. */
  | 'run_tests'
  /** Drive the running preview with a browser and capture what it shows. */
  | 'open_app'
  /** Append to the ticket document. Every role has this — it is how they talk. */
  | 'write_ticket_doc'

export interface Role {
  id: RoleId
  label: string
  /** One line, shown in the UI beside the role's work. */
  does: string
  /** Everything this role may do. Anything absent is refused. */
  tools: ToolId[]
}

export const ROLES: Record<RoleId, Role> = {
  designer: {
    id: 'designer',
    label: 'Designer',
    does: 'Decides what the change should look like and writes it down',
    // Reads and writes the document, and nothing else. §4: cannot touch backend.
    tools: ['read_file', 'write_ticket_doc']
  },
  'test-writer': {
    id: 'test-writer',
    label: 'Test writer',
    does: 'Writes failing tests from the ticket, before there is any code',
    // Deliberately cannot write ordinary source files. Tests written by
    // something that can also change the implementation stop being a check on
    // it, which is the failure §4 Rule 3 exists to prevent.
    tools: ['read_file', 'write_test', 'run_tests', 'commit', 'write_ticket_doc']
  },
  coder: {
    id: 'coder',
    label: 'Coder',
    does: 'Implements against the tests',
    // Cannot write tests. If the coder could edit the tests, a failing test
    // would become an inconvenience rather than a signal.
    tools: ['read_file', 'write_file', 'run_tests', 'commit', 'write_ticket_doc']
  },
  reviewer: {
    id: 'reviewer',
    label: 'Reviewer',
    does: 'Runs the suite, opens the app, and judges it against the ticket',
    // No write tools at all. This is the whole of §4 Rule 2 in one line.
    tools: ['read_file', 'run_tests', 'open_app', 'write_ticket_doc']
  }
}

export function roleAllows(role: RoleId, tool: ToolId): boolean {
  return ROLES[role].tools.includes(tool)
}
