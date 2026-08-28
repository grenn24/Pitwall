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

const cases: { name: string; fix: Fix; expectOk: boolean; maxMs?: number }[] = [
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
    // The point of the machine-state poll: a long-running command that will not
    // finish for 30 seconds is settled the moment the world actually changes.
    name: 'finishes early when the state says so',
    fix: {
      command: 'sleep 30',
      file: 'cmd.exe',
      args: ['/c', 'ping', '-n', '30', '127.0.0.1'],
      elevated: true,
      landed: (() => {
        const from = Date.now()
        return async (): Promise<boolean> => Date.now() - from > 5_000
      })()
    },
    expectOk: true,
    maxMs: 15_000
  },
  {
    // wsl exits zero on an unrecognised option and installs nothing. A clean
    // exit is not evidence that anything happened.
    name: 'clean exit that changes nothing is a failure',
    fix: {
      command: 'true',
      file: 'cmd.exe',
      args: ['/c', 'exit', '0'],
      elevated: true,
      landed: async () => false
    },
    expectOk: false,
    maxMs: 120_000
  },
  {
    // The unelevated path: execFile straight onto the binary, no shell, no
    // script. It must verify against the machine like the elevated one does.
    name: 'runs directly with no shell, and verifies',
    fix: {
      command: 'ver',
      file: 'cmd.exe',
      args: ['/c', 'ver'],
      elevated: false,
      landed: async () => true
    },
    expectOk: true,
    maxMs: 20_000
  },
  {
    name: 'reports a non-zero exit as failure',
    fix: { command: 'exit 3', file: 'cmd.exe', args: ['/c', 'exit', '3'], elevated: true },
    expectOk: false
  }
]

let failures = 0

for (const { name, fix, expectOk, maxMs } of cases) {
  const started = Date.now()
  let ticks = 0
  const outcome = await runViaScript(fix, false, () => {
    ticks++
  })
  const took = Date.now() - started
  const ok = outcome.ok === expectOk && (maxMs === undefined || took <= maxMs)
  if (!ok) failures++
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(36)} ok=${String(outcome.ok).padEnd(5)} ` +
      `${String(Date.now() - started).padStart(5)}ms  progress=${ticks}`
  )
  if (!ok || outcome.error) console.log(`      ${(outcome.error ?? '').split('\n')[0]}`)
}

console.log(failures === 0 ? '\nall passed\n' : `\n${failures} failed\n`)
process.exit(failures === 0 ? 0 : 1)
