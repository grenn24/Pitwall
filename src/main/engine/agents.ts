import { commit, readTicketDoc, runTests, writeFile, writeTicketDoc, type ToolContext } from './tools'
import type { RoleId } from '../../shared/ticket'

/**
 * Stub agents. No model calls anywhere in this file.
 *
 * They exist so the engine around them can be tested where a failure means a
 * bug rather than a bad sample. Checkpointing, handoff and the permission layer
 * are deterministic problems; once a model is in the loop every test is flaky
 * and every diagnosis is a guess. M3 replaces the bodies and leaves the shape.
 *
 * Each one does what its real counterpart will do: read the document, do its
 * work through its own tools, write back what it decided.
 */

export interface AgentResult {
  /** Did the stage produce what the next one needs? */
  produced: boolean
  /** One line for the checkpoint. */
  note: string
}

/** A beat of work, so a run is observable rather than instantaneous. */
const beat = (ms = 400): Promise<void> => new Promise((r) => setTimeout(r, ms))

export const AGENTS: Record<RoleId, (ctx: ToolContext) => Promise<AgentResult>> = {
  designer: async (ctx) => {
    await beat()
    await writeTicketDoc(
      ctx,
      'designer',
      'Spec',
      [
        `Ticket: ${ctx.ticket.title}`,
        '',
        ctx.ticket.body,
        '',
        'Constraints established for this change:',
        '- The change is described by the ticket above and nothing else.',
        '- Anything not stated here is out of scope and must not be invented.'
      ].join('\n')
    )
    return { produced: true, note: 'Spec written to the ticket document' }
  },

  'test-writer': async (ctx) => {
    await beat()
    // Reads the spec rather than being told it. §4 Rule 1: the document is the
    // channel, and this is what reading from it looks like.
    const spec = await readTicketDoc(ctx, 'test-writer')

    await writeFile(
      ctx,
      'test-writer',
      'tests/pitwall.smoke.test.js',
      [
        '// Written from the ticket, before any implementation exists.',
        '// §4 Rule 3: if the code came first, this would describe the bug too.',
        "const { readFileSync, existsSync } = require('node:fs')",
        '',
        'test("the change described by the ticket is present", () => {',
        '  expect(existsSync("IMPLEMENTED.txt")).toBe(true)',
        '})'
      ].join('\n')
    )

    await writeTicketDoc(
      ctx,
      'test-writer',
      'Tests',
      `One test written from the spec (${spec.length} characters read). It fails until the change exists, which is the point.`
    )
    await commit(ctx, 'test-writer', `tests: cover ${ctx.ticket.title}`)

    return { produced: true, note: 'Failing test committed before any code' }
  },

  coder: async (ctx) => {
    await beat()
    await readTicketDoc(ctx, 'coder')

    // The stub's "implementation" is the file the test looks for. A real coder
    // would write real code; the engine cannot tell the difference and does not
    // need to.
    await writeFile(ctx, 'coder', 'IMPLEMENTED.txt', `${ctx.ticket.title}\n\n${ctx.ticket.body}\n`)
    await writeTicketDoc(ctx, 'coder', 'Implementation', 'Implemented the change the spec describes.')
    await commit(ctx, 'coder', ctx.ticket.title)

    return { produced: true, note: 'Implementation committed on the branch' }
  },

  reviewer: async (ctx) => {
    await beat()
    await readTicketDoc(ctx, 'reviewer')

    // Independent ground truth, per §4 Rule 2. The stub runs a command rather
    // than reading a diff, because reading the diff is the failure mode that
    // rule exists to prevent.
    const result = await runTests(ctx, 'reviewer', 'test -f IMPLEMENTED.txt')

    await writeTicketDoc(
      ctx,
      'reviewer',
      'Review',
      result.passed
        ? 'Checked against the ticket by running the suite. It passes.'
        : `Checked against the ticket by running the suite. It fails.\n\n${result.output}`
    )

    return {
      produced: result.passed,
      note: result.passed ? 'Suite passed against the ticket' : 'Suite failed against the ticket'
    }
  }
}
