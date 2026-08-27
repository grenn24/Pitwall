import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { writeState } from '../state'
import { decodeWslOutput } from '../wsl/exec'
import { chooseTargetDistro, defaultWslVersion, listDistros, wslPresent } from './wsl'
import type { FixId, FixOutcome } from '../../shared/doctor'

/**
 * The commands Pitwall runs on the user's behalf.
 *
 * Only WSL. Docker Desktop and anything installed inside the distribution are
 * explained and left to the user: those are large third-party installs that go
 * wrong in ways an automated runner cannot usefully report, and each one we
 * tried to drive added more failure modes than it removed.
 *
 * The renderer asks for a fix id and never supplies a command. If the UI could
 * hand this module a string to run with elevation, one injected script in the
 * renderer would own the machine. Every entry below is a constant.
 */

export interface Fix {
  /** Shown before running, so the user sees exactly what they are agreeing to. */
  command: string
  file: string
  args: string[]
  /** True when Windows will show a UAC prompt. */
  elevated: boolean
  /** True when the change only takes effect after Windows restarts. */
  needsRestart?: boolean
  /** What to show while it runs, for commands that print little. */
  whileRunning?: string
  /** What to expect afterwards. */
  afterward?: string
  /** Recorded when the fix succeeds, for facts the machine cannot report. */
  onSuccess?: () => void
  /**
   * Has this fix taken effect on the machine?
   *
   * The primary completion signal, polled while the command runs. Exit codes,
   * marker files and log output are all proxies for this question, and each of
   * them failed in practice: a console that suspends on a click, a wait that
   * never returned, a log in the wrong encoding, a tool that never flushed a
   * line. The state of the machine cannot lie about any of them.
   */
  landed?: () => Promise<boolean>
}

export const FIXES: Record<FixId, Fix> = {
  'restart-windows': {
    command: 'shutdown /r /t 5',
    file: 'shutdown.exe',
    args: ['/r', '/t', '5'],
    // Restarting your own session is not a privileged operation.
    elevated: false,
    afterward: 'Restarting in a few seconds.'
  },
  'wsl-install': {
    command: 'wsl --install --no-distribution',
    file: 'wsl.exe',
    // --no-distribution is explicit about what this step does. Plain
    // `wsl --install` installs no distribution anyway on current builds, so
    // saying so avoids promising something that will not arrive.
    args: ['--install', '--no-distribution'],
    elevated: true,
    needsRestart: true,
    whileRunning:
      'Installing the WSL2 platform. This takes a few minutes and prints almost nothing while it works.',
    afterward: 'Installed. Windows has to restart before any of it works.',
    landed: async () => wslPresent(),
    onSuccess: () => writeState({ wslInstalledAt: new Date().toISOString() })
  },
  'distro-install': {
    command: 'wsl --install Ubuntu --web-download --no-launch',
    file: 'wsl.exe',
    // Three flags, each earning its place.
    //
    // The distribution is positional. `-d` is not an option of --install, and
    // passing it made wsl exit zero having installed nothing at all — no
    // package, no launcher, no instance. `wsl --install` on its own installs
    // the platform and no distribution, whatever the docs say about a default.
    //
    // --web-download fetches from Microsoft rather than the Store, which
    // stalls indefinitely on a machine with no Store account signed in.
    //
    // --no-launch registers it without starting it. Launching triggers the
    // account setup prompt, and a prompt needs a console, a visible window and
    // a person — all of which this avoids. Commands run as root until someone
    // opens the distribution and creates an account, which is fine for cloning
    // and running containers.
    args: ['--install', 'Ubuntu', '--web-download', '--no-launch'],
    elevated: true,
    whileRunning: 'Downloading and registering Ubuntu. This is a few hundred megabytes.',
    afterward: 'Ubuntu is installed.',
    landed: async () => chooseTargetDistro((await listDistros()).distros) !== null
  },
  'wsl-default-v2': {
    command: 'wsl --set-default-version 2',
    file: 'wsl.exe',
    args: ['--set-default-version', '2'],
    elevated: true,
    landed: async () => (await defaultWslVersion()).version === 2
  }
}

export function fixFor(id: FixId | undefined): Fix | undefined {
  return id ? FIXES[id] : undefined
}

/**
 * Append-only record of what this module actually did.
 *
 * Kept because reasoning about this path from outside the process failed
 * repeatedly. The files a run leaves behind cannot distinguish "never
 * happened" from "happened and was cleaned up".
 */
export const DIAG_PATH = join(tmpdir(), 'pitwall-fix-diagnostics.log')

function diag(line: string): void {
  try {
    appendFileSync(DIAG_PATH, `${new Date().toISOString()}  ${line}\r\n`, 'utf8')
  } catch {
    // Diagnostics must never be the reason something fails.
  }
}

/**
 * Write a PowerShell script the way Windows PowerShell will read it.
 *
 * A .ps1 without a byte order mark is read as ANSI by Windows PowerShell 5.1,
 * so anything outside ASCII arrives mangled. Not cosmetic: these scripts embed
 * file paths, and a user whose name is not ASCII would get a broken path and an
 * error that looks like anything but an encoding problem.
 */
function writePowerShellScript(path: string, body: string): void {
  writeFileSync(path, `﻿${body}`, 'utf8')
}

export function runFix(id: FixId, onProgress?: (text: string) => void): Promise<FixOutcome> {
  const fix = fixFor(id)
  if (!fix) return Promise.resolve({ ok: false, error: 'No fix is defined for this check.' })
  if (!fix.elevated) return runPlain(fix)
  return runViaScript(fix, true, onProgress)
}

function runPlain(fix: Fix): Promise<FixOutcome> {
  return new Promise((resolve) => {
    execFile(fix.file, fix.args, { timeout: 30 * 60_000, windowsHide: true, encoding: 'buffer' }, (err, out, errOut) => {
      if (!err) {
        fix.onSuccess?.()
        resolve({ ok: true, afterward: fix.afterward, needsRestart: fix.needsRestart })
        return
      }
      resolve({ ok: false, error: explain(Buffer.concat([out as Buffer, errOut as Buffer]).toString('utf8'), err) })
    })
  })
}

/**
 * Run an elevated fix with no visible console.
 *
 * A Windows console has QuickEdit on by default, so one click inside it
 * suspends the process — the title gains the word "Select" and nothing else
 * happens, which is indistinguishable from a slow install. The window is
 * therefore hidden and output is appended to a log we poll.
 *
 * Elevation cannot be combined with output redirection on Start-Process, and
 * composing the equivalent inline needs three levels of nested quoting, so the
 * command runs from a generated script.
 *
 * `elevate` is a parameter so the whole path can be tested without UAC.
 */
export function runViaScript(fix: Fix, elevate: boolean, onProgress?: (text: string) => void): Promise<FixOutcome> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const logPath = join(tmpdir(), `pitwall-fix-${stamp}.log`)
  const donePath = join(tmpdir(), `pitwall-fix-${stamp}.done`)
  const scriptPath = join(tmpdir(), `pitwall-fix-${stamp}.ps1`)

  const psArgs = fix.args.map((a) => `'${a.replaceAll("'", "''")}'`).join(',')
  writePowerShellScript(
    scriptPath,
    [
      "$ErrorActionPreference = 'Continue'",
      // Appended line by line rather than piped to Out-File, which buffers the
      // whole pipeline and writes only at the end — an empty log for the entire
      // length of an install looks exactly like a hang.
      `& '${fix.file}' @(${psArgs}) *>&1 | ForEach-Object { Add-Content -Path '${logPath}' -Encoding utf8 -Value $_ }`,
      '$code = $LASTEXITCODE',
      'if ($null -eq $code) { $code = 0 }',
      // Completion is signalled by a separate one-line file. The log is held
      // open by the redirection and carries whatever encoding the tool chose;
      // a dedicated file has neither problem and needs no parsing.
      `Set-Content -Path '${donePath}' -Encoding ascii -Value $code`,
      'exit $code'
    ].join('\r\n')
  )

  diag(`start ${fix.command} elevate=${elevate} script=${scriptPath}`)

  return new Promise((resolve) => {
    let settled = false
    let lastText = ''
    let lastChange = Date.now()
    let polls = 0
    let checkingLanded = false
    // When the process reports success but the fix has a way to check the
    // machine, the machine gets the final word. A command that exits zero
    // having done nothing is not a hypothetical: wsl exits zero on an
    // unrecognised option, and reported a distribution installed that was
    // never downloaded.
    let processSucceededAt: number | null = null

    const cleanup = (keepLog: boolean): void => {
      clearInterval(poll)
      if (landedPoll) clearInterval(landedPoll)
      for (const file of keepLog ? [scriptPath, donePath] : [scriptPath, donePath, logPath]) {
        try {
          unlinkSync(file)
        } catch {
          // Best effort. A stray file in temp is not worth failing over.
        }
      }
    }

    const done = (outcome: FixOutcome): void => {
      if (settled) return
      settled = true
      if (outcome.ok) fix.onSuccess?.()
      diag(`done ok=${outcome.ok} polls=${polls} error=${outcome.error ?? ''}`)
      cleanup(!outcome.ok)
      resolve(outcome.ok ? outcome : { ...outcome, error: `${outcome.error}\n\nFull output: ${logPath}` })
    }

    const readLog = (): string => {
      try {
        // Sniffed, not assumed. Some Windows tools write UTF-16 whatever the
        // redirection asked for, and a NUL between every character is easy to
        // miss in a log yet fatal to a string search.
        return decodeWslOutput(readFileSync(logPath)).replace(/^﻿/, '')
      } catch {
        return ''
      }
    }

    // The machine-state check runs on its own slower cadence, since each one
    // may shell into the distribution and is far from free.
    const landedPoll = fix.landed
      ? setInterval(() => {
          if (settled || checkingLanded) return
          checkingLanded = true
          void fix
            .landed?.()
            .then((yes) => {
              if (yes && !settled) {
                diag('landed=true — machine state confirms the fix took effect')
                onProgress?.(lastText)
                done({ ok: true, afterward: fix.afterward, needsRestart: fix.needsRestart })
              }
            })
            .catch(() => {
              // A probe that cannot answer is not a failure; keep waiting.
            })
            .finally(() => {
              checkingLanded = false
            })
        }, 4_000)
      : null

    const poll = setInterval(() => {
      polls++
      const text = readLog()
      if (polls === 1 || polls % 20 === 0) {
        diag(`poll ${polls} done=${existsSync(donePath)} logBytes=${text.length}`)
      }

      if (existsSync(donePath)) {
        let code = 0
        try {
          code = Number(readFileSync(donePath, 'ascii').trim()) || 0
        } catch {
          // Written but not yet readable; let the machine check be the judge.
        }
        onProgress?.(text)
        if (code !== 0) {
          done({ ok: false, error: explain(text, `exit ${code}`) })
          return
        }
        if (!fix.landed) {
          done({ ok: true, afterward: fix.afterward, needsRestart: fix.needsRestart })
          return
        }
        // Exited cleanly, but this fix can be verified. Wait for the machine.
        processSucceededAt ??= Date.now()
      }

      // A clean exit that never shows up on the machine is a failure, and
      // saying so is far better than reporting a success nobody can see.
      if (processSucceededAt && Date.now() - processSucceededAt > 90_000) {
        done({
          ok: false,
          error: `The command finished without error, but nothing changed on this machine.

${
            text.trim().split('\n').slice(-4).join('\n') || '(no output)'
          }`
        })
        return
      }

      if (text && text !== lastText) {
        lastText = text
        lastChange = Date.now()
        onProgress?.(text)
        return
      }

      // Say so rather than showing nothing. A nested VM can genuinely take this
      // long, and silence is the only thing worth flagging.
      const stalledFor = Math.round((Date.now() - lastChange) / 1000)
      if (stalledFor >= 180 && stalledFor % 30 < 1) {
        onProgress?.(
          `${lastText}\n\n[still running — no new output for ${Math.round(stalledFor / 60)} min]\n[log: ${logPath}]`
        )
      }
    }, 900)

    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$p = Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${scriptPath}'${
          elevate ? ' -Verb RunAs' : ''
        } -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode`
      ],
      { timeout: 45 * 60_000, windowsHide: true, encoding: 'buffer' },
      (err, out, errOut) => {
        const log = readLog()
        diag(`execFile returned err=${err ? String(err).split('\n')[0] : 'none'} doneExists=${existsSync(donePath)}`)
        if (!err) {
          if (!fix.landed) {
            done({ ok: true, afterward: fix.afterward, needsRestart: fix.needsRestart })
            return
          }
          // Verifiable fixes wait for the machine to agree; the poll settles it.
          processSucceededAt ??= Date.now()
          return
        }
        done({
          ok: false,
          error: explain(log + Buffer.concat([out as Buffer, errOut as Buffer]).toString('utf8'), err)
        })
      }
    )
  })
}

/** Turn whatever the command produced into something worth reading. */
function explain(text: string, err: unknown): string {
  const blob = text + String(err)
  if (/1223|operation was canceled/i.test(blob)) {
    return 'Cancelled at the Windows permission prompt. Nothing was changed.'
  }
  return text.trim().split('\n').slice(-4).join('\n') || 'The command did not complete.'
}
