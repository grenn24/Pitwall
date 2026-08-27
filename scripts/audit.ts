/**
 * Exercise the paths a clean machine will walk, on this machine, before
 * someone else has to find out they are broken.
 */
import { FIXES, buildInteractiveScript } from '../src/main/doctor/fixes'
import { runDoctor } from '../src/main/doctor/index'
import { chooseTargetDistro, listDistros, wslPresent } from '../src/main/doctor/wsl'
import { readState } from '../src/main/state'
import { wslExec } from '../src/main/wsl/exec'
import { execFile } from 'node:child_process'
import { unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let bad = 0
const line = (ok: boolean, label: string, detail = ''): void => {
  if (!ok) bad++
  console.log(`${ok ? 'ok  ' : 'BAD '} ${label.padEnd(46)} ${detail}`)
}

// 1 — every landed predicate must answer without throwing.
for (const [id, fix] of Object.entries(FIXES)) {
  if (!fix.landed) {
    line(true, `${id}: no predicate`, '(expected for restart)')
    continue
  }
  const started = Date.now()
  try {
    const value = await fix.landed()
    line(true, `${id}: predicate answers`, `${value} in ${Date.now() - started}ms`)
  } catch (error) {
    line(false, `${id}: predicate threw`, String(error).split('\n')[0])
  }
}

// 1b — a distribution-scoped fix must resolve its arguments.
for (const [id, fix] of Object.entries(FIXES)) {
  if (!fix.argsFor) continue
  const { distros } = await listDistros()
  const target = chooseTargetDistro(distros)
  const args = target ? fix.argsFor(target.name) : []
  line(args.length > 0 && args.includes(target?.name ?? ''), `${id}: binds to a distribution`, args.join(' '))
}

// 1c — the script an interactive fix opens must be valid PowerShell, and must
// wait at the end. A window that closes on exit shows a flash and no error.
for (const [id, fix] of Object.entries(FIXES)) {
  if (!fix.interactive) continue
  const script = buildInteractiveScript(fix)
  const file = join(tmpdir(), `pitwall-audit-${id}.ps1`)
  writeFileSync(file, script, 'utf8')

  const parsed = await new Promise<string>((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-Command', `$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${file}',[ref]$null,[ref]$e); if($e.Count){$e[0].Message}else{'ok'}`],
      { windowsHide: true, timeout: 30_000 },
      (err, out) => resolve(err ? String(err) : String(out).trim())
    )
  })
  unlinkSync(file)

  line(parsed === 'ok', `${id}: interactive script parses`, parsed === 'ok' ? '' : parsed)
  line(script.includes('Read-Host'), `${id}: window waits before closing`)
}

// 2 — every fix must name a real executable.
for (const [id, fix] of Object.entries(FIXES)) {
  const probe = await import('node:child_process')
  const found = await new Promise<boolean>((resolve) => {
    probe.execFile('where.exe', [fix.file], { windowsHide: true }, (err) => resolve(!err))
  })
  line(found, `${id}: ${fix.file} on PATH`)
}

// 3 — the tools the workspace layer assumes exist inside the distribution.
const { distros } = await listDistros()
const target = chooseTargetDistro(distros)
if (!target) {
  line(false, 'a usable distribution exists')
} else {
  for (const tool of ['git', 'docker', 'bash', 'tar']) {
    const r = await wslExec(target.name, `command -v ${tool} >/dev/null 2>&1 && echo yes || echo no`, 30_000)
    const present = r.stdout.trim().split(/\r?\n/).pop() === 'yes'
    line(present, `${target.name}: ${tool} present`, present ? '' : 'the workspace layer needs this')
  }
}

// 3b — the pending-restart claim rests on our own record, never on a guess.
const working = await wslPresent()
const recorded = Boolean(readState().wslInstalledAt)
line(!(working && recorded), 'no stale install record while WSL works', `wsl=${working} recorded=${recorded}`)

// 4 — the doctor must never report ready without a target distro.
const report = await runDoctor()
line(!report.ready || Boolean(report.targetDistro), 'ready implies a target distribution')
line(report.checks.length === 6, 'report always lists every check', `${report.checks.length}`)

console.log(bad === 0 ? '\nno problems found\n' : `\n${bad} problem(s)\n`)
process.exit(bad === 0 ? 0 : 1)
