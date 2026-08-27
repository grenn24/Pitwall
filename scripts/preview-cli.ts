/**
 * The whole M0 loop end to end, against a real repository:
 * clone → worktree → containers → preview URL → teardown.
 *
 *   npm run preview -- <git-url> [ticket-id] [--keep]
 *
 * Prints the cold-start number M0 asks for.
 */
import { runDoctor } from '../src/main/doctor/index'
import { cloneRepo, createWorktree, removeWorktree } from '../src/main/workspace/index'
import { containersFor, startPreview, stopPreview } from '../src/main/preview/index'
import { DB_NAME, DB_USER } from '../src/main/preview/compose'
import { wslExec } from '../src/main/wsl/exec'

const remote = process.argv[2] ?? 'https://github.com/docker/welcome-to-docker.git'
const ticketId = process.argv[3] ?? 'preview-1'
const keep = process.argv.includes('--keep')

const t0 = Date.now()
const step = (label: string): void => console.log(`\n── ${label}`)

const doctor = await runDoctor()
if (!doctor.ready || !doctor.targetDistro) {
  console.error('Environment is not ready. Run "npm run doctor".')
  process.exit(1)
}
const distro = doctor.targetDistro
console.log(`distro   : ${distro}`)
console.log(`repo     : ${remote}`)
console.log(`ticket   : ${ticketId}`)

step('clone')
const { repo, timings: cloneTimings, reused } = await cloneRepo(distro, remote)
console.log(`  ${repo.path} (${reused ? 'reused' : 'fresh'}, default ${repo.defaultBranch})`)

step('worktree')
const { worktree, timings: wtTimings } = await createWorktree(distro, repo, ticketId)
console.log(`  ${worktree.path} on ${worktree.branch}`)

step('preview')
const status = await startPreview({
  distro,
  repo,
  worktree,
  onPhase: (s) => console.log(`  ${s.phase}`)
})

if (status.phase !== 'ready' || !status.env) {
  console.error(`\nFAILED: ${status.error ?? 'unknown'}`)
  if (status.env) await stopPreview(distro, status.env.composePath)
  await removeWorktree(distro, repo, ticketId)
  process.exit(1)
}

const env = status.env
console.log(`\n  url          : ${env.url}`)
console.log(`  database     : ${env.databaseUrl}`)
console.log(`  app source   : ${status.appSource}`)
console.log(`  containers   : ${(await containersFor(distro, env.project)).join(', ')}`)

step('verify the seed actually ran')
const seedCheck = await wslExec(
  distro,
  `docker compose -f ${env.composePath} exec -T db psql -U ${DB_USER} -d ${DB_NAME} -tAc "select count(*) from pitwall_smoke" 2>/dev/null || echo "project seed (no pitwall_smoke table)"`
)
console.log(`  ${seedCheck.stdout.trim()}`)

step('verify the app answers')
const probe = await fetch(env.url, { redirect: 'manual' }).catch(() => null)
console.log(`  HTTP ${probe?.status ?? 'no response'}`)

if (keep) {
  console.log(`\nleaving it up (--keep). Tear down with:`)
  console.log(`  wsl -d ${distro} -e bash -lc "docker compose -f ${env.composePath} down --volumes"`)
} else {
  step('teardown')
  await stopPreview(distro, env.composePath)
  await removeWorktree(distro, repo, ticketId)
  const left = await containersFor(distro, env.project)
  console.log(`  containers remaining : ${left.length === 0 ? 'none' : left.join(', ')}`)
}

console.log('\ntimings')
for (const t of [...cloneTimings, ...wtTimings]) console.log(`  ${t.label.padEnd(16)} ${String(t.ms).padStart(6)} ms`)
console.log(`  ${'preview up'.padEnd(16)} ${String(status.elapsedMs ?? 0).padStart(6)} ms`)
console.log(`  ${'TOTAL'.padEnd(16)} ${String(Date.now() - t0).padStart(6)} ms\n`)
