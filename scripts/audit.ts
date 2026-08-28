/**
 * Exercise the paths a clean machine will walk, on this machine, before
 * someone else has to find out they are broken.
 *
 *   npm run audit
 */
import { runDoctor } from '../src/main/doctor/index'
import { chooseTargetDistro, listDistros } from '../src/main/doctor/wsl'
import { wslExec } from '../src/main/wsl/exec'

let bad = 0
const line = (ok: boolean, label: string, detail = ''): void => {
  if (!ok) bad++
  console.log(`${ok ? 'ok  ' : 'BAD '} ${label.padEnd(46)} ${detail}`)
}

// 1 — the tools the workspace layer assumes exist inside the distribution.
const { distros } = await listDistros()
const target = chooseTargetDistro(distros)
if (!target) {
  line(false, 'a usable distribution exists')
} else {
  for (const tool of ['git', 'docker', 'bash', 'tar']) {
    const result = await wslExec(target.name, `command -v ${tool} >/dev/null 2>&1 && echo yes || echo no`, 30_000)
    const present = result.stdout.trim().split(/\r?\n/).pop() === 'yes'
    line(present, `${target.name}: ${tool} present`, present ? '' : 'the workspace layer needs this')
  }
}

// 2 — the report itself.
const report = await runDoctor()
line(!report.ready || Boolean(report.targetDistro), 'ready implies a target distribution')
line(report.checks.length === 5, 'report always lists every check', `${report.checks.length}`)

// 3 — anything the user has to act on must say what to do, and a check that
// hands over a command must say where to run it. An instruction with no command
// and no documentation is a dead end.
for (const check of report.checks) {
  if (check.status === 'ok' || check.status === 'pending') continue
  line(Boolean(check.remediation), `${check.id}: says what to do`)
  line(Boolean(check.command || check.docsUrl), `${check.id}: offers a command or a link`)
  if (check.command) line(Boolean(check.shell), `${check.id}: says where to run it`)
}

console.log(bad === 0 ? '\nno problems found\n' : `\n${bad} problem(s)\n`)
process.exit(bad === 0 ? 0 : 1)
