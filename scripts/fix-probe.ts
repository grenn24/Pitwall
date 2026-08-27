/**
 * Exercise the elevated-fix machinery without elevation.
 *
 * Same script generation, same redirection, same completion signal, same
 * polling and cleanup — only the UAC step is skipped. Three attempts to make
 * this path report completion failed on a real machine, so it gets a test that
 * does not need a virtual machine and a human to run.
 *
 *   npm run fix-probe
 */
import { runViaScript, type Fix } from '../src/main/doctor/fixes'

const cases: { name: string; fix: Fix; expectOk: boolean }[] = [
  {
    name: 'succeeds and reports output',
    fix: { command: 'ver', file: 'cmd.exe', args: ['/c', 'ver'], elevated: true, afterward: 'done' },
    expectOk: true
  },
  {
    name: 'streams output while running',
    fix: { command: 'ping', file: 'cmd.exe', args: ['/c', 'ping', '-n', '4', '127.0.0.1'], elevated: true },
    expectOk: true
  },
  {
    name: 'reports a non-zero exit as failure',
    fix: { command: 'exit 3', file: 'cmd.exe', args: ['/c', 'exit', '3'], elevated: true },
    expectOk: false
  }
]

let failures = 0

for (const { name, fix, expectOk } of cases) {
  const started = Date.now()
  let ticks = 0
  const outcome = await runViaScript(fix, false, () => {
    ticks++
  })
  const ok = outcome.ok === expectOk
  if (!ok) failures++
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(36)} ok=${String(outcome.ok).padEnd(5)} ` +
      `${String(Date.now() - started).padStart(5)}ms  progress=${ticks}`
  )
  if (!ok || outcome.error) console.log(`      ${(outcome.error ?? '').split('\n')[0]}`)
}

console.log(failures === 0 ? '\nall passed\n' : `\n${failures} failed\n`)
process.exit(failures === 0 ? 0 : 1)
