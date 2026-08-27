/**
 * Run the environment probe from a terminal, without launching Electron.
 *
 * The same code path the first-run screen uses, so a green run here means the
 * screen will be green too. `npm run doctor`.
 */
import { runDoctor } from '../src/main/doctor/index'

const MARK: Record<string, string> = { ok: '  OK  ', warn: ' WARN ', fail: ' FAIL ', checking: '  ..  ' }

const report = await runDoctor()

console.log('')
for (const check of report.checks) {
  console.log(`[${MARK[check.status]}] ${check.label}`)
  console.log(`          ${check.detail}`)
  if (check.remediation) console.log(`          → ${check.remediation}`)
  console.log('')
}

console.log(`target distro : ${report.targetDistro ?? '(none)'}`)
console.log(`probe time    : ${report.elapsedMs} ms`)
console.log(`ready         : ${report.ready ? 'yes' : 'no'}`)

process.exit(report.ready ? 0 : 1)
