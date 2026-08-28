import { shellQuote, wslExec, wslExecOrThrow } from '../wsl/exec'
import { recordRefusal } from './store'
import { roleAllows, type ToolId } from './roles'
import type { RoleId, Ticket } from '../../shared/ticket'

/**
 * Every action an agent can take, and the gate in front of them.
 *
 * Nothing an agent does reaches the machine except through this module. That is
 * the point: §4 Rule 2 says the Reviewer must not be able to write code, and
 * the only way to mean it is for the write tools to be absent from the
 * Reviewer's hands rather than discouraged in its instructions.
 *
 * A refused call is not an error the agent can retry differently. It is
 * recorded and returned as a refusal, so the attempt is visible afterwards.
 */

export class ToolRefused extends Error {
  constructor(
    readonly role: RoleId,
    readonly tool: ToolId
  ) {
    super(`The ${role} role has no ${tool} tool.`)
    this.name = 'ToolRefused'
  }
}

export interface ToolContext {
  distro: string
  ticket: Ticket
}

/**
 * The gate.
 *
 * Called for every tool use. Takes the role rather than reading it from
 * anywhere ambient, so a caller cannot quietly act as somebody else.
 */
export function assertAllowed(role: RoleId, tool: ToolId): void {
  if (roleAllows(role, tool)) return
  recordRefusal({
    role,
    tool,
    at: new Date().toISOString(),
    reason: `The ${role} role does not have the ${tool} tool.`
  })
  throw new ToolRefused(role, tool)
}

/** Paths that count as tests, for the tool that may only write them. */
const TEST_PATTERNS = [/(^|\/)tests?\//, /(^|\/)__tests__\//, /\.(test|spec)\.[a-z]+$/]

function looksLikeTest(relativePath: string): boolean {
  return TEST_PATTERNS.some((pattern) => pattern.test(relativePath))
}

export async function readFile(ctx: ToolContext, role: RoleId, relativePath: string): Promise<string> {
  assertAllowed(role, 'read_file')
  const result = await wslExec(ctx.distro, `cat ${shellQuote(`${ctx.ticket.worktree}/${relativePath}`)} 2>/dev/null || true`)
  return result.stdout
}

export async function writeFile(
  ctx: ToolContext,
  role: RoleId,
  relativePath: string,
  contents: string
): Promise<void> {
  // Which tool this needs depends on where it is going, so the check follows
  // the path rather than the caller's word for it. A coder writing into a test
  // directory is a coder editing the tests that judge it.
  assertAllowed(role, looksLikeTest(relativePath) ? 'write_test' : 'write_file')

  const target = `${ctx.ticket.worktree}/${relativePath}`
  await wslExecOrThrow(ctx.distro, `mkdir -p "$(dirname ${shellQuote(target)})"`)
  await wslExecOrThrow(
    ctx.distro,
    `cat > ${shellQuote(target)} <<'PITWALL_FILE_EOF'\n${contents}\nPITWALL_FILE_EOF`
  )
}

export async function commit(ctx: ToolContext, role: RoleId, message: string): Promise<string> {
  assertAllowed(role, 'commit')
  await wslExecOrThrow(ctx.distro, `cd ${shellQuote(ctx.ticket.worktree ?? '')} && git add -A`)
  const result = await wslExec(
    ctx.distro,
    `cd ${shellQuote(ctx.ticket.worktree ?? '')} && git -c user.name=${shellQuote(role)} ` +
      `-c user.email=${shellQuote(`${role}@pitwall.local`)} commit -m ${shellQuote(message)} --allow-empty`
  )
  const sha = await wslExec(ctx.distro, `cd ${shellQuote(ctx.ticket.worktree ?? '')} && git rev-parse HEAD`)
  return sha.stdout.trim() || result.stdout.trim()
}

export interface TestResult {
  ran: boolean
  passed: boolean
  output: string
}

export async function runTests(ctx: ToolContext, role: RoleId, command: string): Promise<TestResult> {
  assertAllowed(role, 'run_tests')
  const result = await wslExec(ctx.distro, `cd ${shellQuote(ctx.ticket.worktree ?? '')} && ${command}`, 300_000)
  return {
    ran: !result.timedOut,
    // Exit code is the whole contract, per §6: run whatever test command the
    // project already has and read what it returns.
    passed: result.code === 0 && !result.timedOut,
    output: (result.stdout + result.stderr).trim()
  }
}

/**
 * Append to the ticket document.
 *
 * The only channel between roles. §4 Rule 1: agents share state rather than
 * messaging, and every write is attributed and timestamped so a human reading
 * it afterwards can see which role said what.
 */
export async function writeTicketDoc(ctx: ToolContext, role: RoleId, section: string, body: string): Promise<void> {
  assertAllowed(role, 'write_ticket_doc')
  const entry = [
    '',
    `## ${section}`,
    `_${role} · ${new Date().toISOString()}_`,
    '',
    body.trim(),
    ''
  ].join('\n')

  const path = `${ctx.ticket.worktree}/PITWALL_TICKET.md`
  await wslExecOrThrow(ctx.distro, `cat >> ${shellQuote(path)} <<'PITWALL_DOC_EOF'\n${entry}\nPITWALL_DOC_EOF`)
}

export async function readTicketDoc(ctx: ToolContext, role: RoleId): Promise<string> {
  assertAllowed(role, 'read_file')
  const result = await wslExec(ctx.distro, `cat ${shellQuote(`${ctx.ticket.worktree}/PITWALL_TICKET.md`)} 2>/dev/null || true`)
  return result.stdout
}

/** Placeholder until M5 gives the Reviewer a real browser. */
export async function openApp(_ctx: ToolContext, role: RoleId, url: string): Promise<{ status: number | null }> {
  assertAllowed(role, 'open_app')
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: 'manual' })
    return { status: response.status }
  } catch {
    return { status: null }
  }
}
