/**
 * Drive the run engine against the real machine, with no model calls.
 *
 *   npm run engine
 *
 * Proves M2's exit criteria in order: a full run end to end, a run killed
 * mid-stage and resumed, and a role refused a tool it does not have.
 */
import { runDoctor } from '../src/main/doctor/index'
import { cloneRepo, createWorktree, removeWorktree } from '../src/main/workspace/index'
import { createTicket, loadTicket, readRefusals, resume, run } from '../src/main/engine/index'
import { advance } from '../src/main/engine/machine'
import { deleteTicket, saveTicket } from '../src/main/engine/store'
import { ToolRefused, writeFile } from '../src/main/engine/tools'
import { ROLES } from '../src/main/engine/roles'
import type { Ticket } from '../src/shared/ticket'

const REPO = process.argv[2] ?? 'https://github.com/octocat/Hello-World.git'

let failures = 0
const check = (ok: boolean, label: string, detail = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'BAD '} ${label.padEnd(52)} ${detail}`)
}

const doctor = await runDoctor()
if (!doctor.ready || !doctor.targetDistro) {
  console.error('Environment is not ready. Run "npm run doctor".')
  process.exit(1)
}
const distro = doctor.targetDistro
console.log(`\ndistro: ${distro}\nrepo  : ${REPO}\n`)

// ---------------------------------------------------------------- happy path
console.log('— a full run, no model calls —')
const { repo } = await cloneRepo(distro, REPO)
const ticketId = 'engine-happy'
await removeWorktree(distro, repo, ticketId).catch(() => undefined)
const { worktree } = await createWorktree(distro, repo, ticketId)

let ticket = createTicket({ title: 'Add a greeting', body: 'The app should greet the user by name.', repo: repo.slug })
ticket = { ...ticket, branch: worktree.branch, worktree: worktree.path }
saveTicket(ticket)

const seen: string[] = []
ticket = await run(ticket.id, { distro, onCheckpoint: (t) => seen.push(t.state) })

check(ticket.state === 'review_passed', 'a full run reaches review_passed', ticket.state)
check(seen.includes('spec_ready'), 'the designer produced a spec')
check(seen.includes('tests_written'), 'tests were written before code')
check(
  seen.indexOf('tests_written') < seen.indexOf('code_complete'),
  'tests came before the implementation',
  `${seen.indexOf('tests_written')} < ${seen.indexOf('code_complete')}`
)
check(ticket.checkpoints.length >= 8, 'every transition was checkpointed', `${ticket.checkpoints.length}`)
check(ticket.cost.usd === 0, 'nothing was spent', `$${ticket.cost.usd}`)

// ------------------------------------------------------------------- resume
console.log('\n— killed mid-stage, then resumed —')
const killedId = 'engine-killed'
await removeWorktree(distro, repo, killedId).catch(() => undefined)
const killedTree = await createWorktree(distro, repo, killedId)

let killed = createTicket({ title: 'Interrupted', body: 'This run gets killed halfway.', repo: repo.slug })
killed = { ...killed, branch: killedTree.worktree.branch, worktree: killedTree.worktree.path }
saveTicket(killed)

// Stop before the coder starts, then simulate the crash by writing a state
// that says a stage was in flight — exactly what a killed process leaves.
killed = await run(killed.id, { distro, stopBefore: 'tests_written' })
check(killed.state === 'tests_written', 'stopped where it was told', killed.state)

killed = advance(killed, 'writing_code', 'coder started')
const onDisk = loadTicket(killed.id)
check(onDisk?.state === 'writing_code', 'the in-flight stage was on disk before the crash', onDisk?.state ?? 'missing')

const rewound = resume(onDisk as Ticket)
check(rewound.state === 'tests_written', 'resume rewinds to the start of that stage', rewound.state)

const finished = await run(killed.id, { distro })
check(finished.state === 'review_passed', 'the resumed run completes', finished.state)
check(
  finished.checkpoints.some((c) => c.note.includes('Resumed')),
  'the resume is recorded in the ticket history'
)

// ---------------------------------------------------------------- the gate
console.log('\n— the permission layer —')
const before = readRefusals().length

try {
  // The reviewer has no write tool at all. §4 Rule 2 in one call.
  await writeFile({ distro, ticket: finished }, 'reviewer', 'src/sneaky.ts', 'export const nope = true')
  check(false, 'the reviewer is refused a write', 'it was allowed')
} catch (error) {
  check(error instanceof ToolRefused, 'the reviewer is refused a write', (error as Error).message)
}

try {
  // The coder may write source but not tests, so a failing test cannot simply
  // be edited into a passing one.
  await writeFile({ distro, ticket: finished }, 'coder', 'tests/cheat.test.js', 'test("", () => {})')
  check(false, 'the coder is refused a test file', 'it was allowed')
} catch (error) {
  check(error instanceof ToolRefused, 'the coder is refused a test file', (error as Error).message)
}

check(readRefusals().length === before + 2, 'both refusals were recorded', `${readRefusals().length - before}`)
check(!ROLES.reviewer.tools.includes('write_file'), 'the reviewer has no write tool to begin with')

// ------------------------------------------------------------------ tidy up
await removeWorktree(distro, repo, ticketId).catch(() => undefined)
await removeWorktree(distro, repo, killedId).catch(() => undefined)
// This store is the one the app reads. A harness that leaves its tickets
// behind puts them in front of the user.
deleteTicket(ticket.id)
deleteTicket(finished.id)

console.log(failures === 0 ? '\nall passed\n' : `\n${failures} failed\n`)
process.exit(failures === 0 ? 0 : 1)
