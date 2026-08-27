/**
 * Exercise the full workspace path against a real repository, and print the
 * timings. `npm run workspace -- <git-url> [ticket-id]`.
 *
 * This is the evidence M0 exists to produce: whether clone and worktree work on
 * WSL2 is not a question anyone should answer from intuition.
 */
import { runDoctor } from '../src/main/doctor/index'
import {
  checkFilesystem,
  cloneRepo,
  createWorktree,
  listWorktrees,
  removeWorktree
} from '../src/main/workspace/index'

const remote = process.argv[2] ?? 'https://github.com/octocat/Hello-World.git'
const ticketId = process.argv[3] ?? 'demo-1'
const keep = process.argv.includes('--keep')

function ms(n: number): string {
  return `${String(n).padStart(6)} ms`
}

const doctor = await runDoctor()
if (!doctor.targetDistro) {
  console.error('No usable WSL2 distribution. Run "npm run doctor" for details.')
  process.exit(1)
}
const distro = doctor.targetDistro
console.log(`\ndistro        : ${distro}`)

const fs = await checkFilesystem(distro)
console.log(`workspace     : ${fs.root}`)
console.log(`filesystem    : ${fs.fsType}${fs.isNative ? '' : '  ← WARNING: not a native Linux filesystem'}`)

console.log(`\nrepo          : ${remote}`)
const { repo, timings: cloneTimings, reused } = await cloneRepo(distro, remote, (line) =>
  console.log(`                ${line}`)
)

console.log(`path          : ${repo.path}`)
console.log(`default branch: ${repo.defaultBranch}`)
console.log(`head          : ${repo.headSha.slice(0, 12)}`)
console.log(`reused clone  : ${reused ? 'yes' : 'no'}`)

const { worktree, timings: wtTimings } = await createWorktree(distro, repo, ticketId)
console.log(`\nworktree      : ${worktree.path}`)
console.log(`branch        : ${worktree.branch}`)

const listed = await listWorktrees(distro, repo)
console.log(`live worktrees: ${listed.length} (${listed.map((w) => w.branch).join(', ') || 'none'})`)

let teardown: { label: string; ms: number }[] = []
if (keep) {
  console.log('\nkeeping the worktree (--keep)')
} else {
  teardown = await removeWorktree(distro, repo, ticketId)
  const after = await listWorktrees(distro, repo)
  console.log(`after teardown: ${after.length} worktree(s) remaining`)
}

console.log('\ntimings')
for (const t of [...cloneTimings, ...wtTimings, ...teardown]) {
  console.log(`  ${t.label.padEnd(16)} ${ms(t.ms)}`)
}
console.log('')
