import { execFile } from 'node:child_process'

import type { CheckId } from '../../shared/doctor'
import type { FixOutcome } from '../../shared/doctor'

/**
 * Commands Pitwall will run on the user's behalf.
 *
 * A fixed table, keyed by check. The renderer asks for a check id and never
 * supplies a command — if the UI could hand this module a string to run with
 * elevation, one injected script in the renderer would own the machine.
 *
 * Two things deliberately absent:
 *
 *   Docker Desktop. Installing it means downloading and executing a third-party
 *   installer, which is not something an app should do quietly on someone's
 *   behalf. We link to it and let them decide.
 *
 *   Anything that takes an argument. Every entry below is a constant. The moment
 *   a fix needs a distro name or a path from the environment, it needs a review
 *   of how that value is escaped, and there is no such fix yet.
 */

export interface Fix {
  /** Shown before running, so the user sees exactly what they are agreeing to. */
  command: string
  file: string
  args: string[]
  /** True when Windows will show a UAC prompt. */
  elevated: boolean
  /** What the user should expect afterwards. */
  afterward?: string
}

export const FIXES: Partial<Record<CheckId, Fix>> = {
  wsl: {
    command: 'wsl --install',
    file: 'wsl.exe',
    args: ['--install'],
    elevated: true,
    afterward: 'Windows needs to restart before this takes effect.'
  },
  wslVersion: {
    command: 'wsl --set-default-version 2',
    file: 'wsl.exe',
    args: ['--set-default-version', '2'],
    elevated: true
  },
  distro: {
    command: 'wsl --install -d Ubuntu',
    file: 'wsl.exe',
    args: ['--install', '-d', 'Ubuntu'],
    // Installing a distribution has not required elevation since the store
    // based WSL shipped, and asking for it anyway trains people to click
    // through UAC prompts without reading them.
    elevated: false,
    afterward: 'Ubuntu will ask you to choose a username and password.'
  }
}

export function fixFor(id: CheckId): Fix | undefined {
  return FIXES[id]
}

/**
 * Run a fix and report how it went.
 *
 * Elevated commands go through Start-Process -Verb RunAs, which is what raises
 * the UAC dialog. Their output is not capturable — the elevated process has its
 * own console — so those report only an exit code, and the doctor re-runs
 * afterwards to find out what actually changed. That is the honest signal
 * anyway: what matters is the state of the machine, not what a command printed.
 */
export function runFix(id: CheckId): Promise<FixOutcome> {
  const fix = fixFor(id)
  if (!fix) return Promise.resolve({ ok: false, error: 'No fix is defined for this check.' })

  const file = fix.elevated ? 'powershell.exe' : fix.file
  const args = fix.elevated
    ? [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        // Arguments are constants from the table above, never interpolated
        // from anything the renderer or the environment supplied.
        `$p = Start-Process -FilePath '${fix.file}' -ArgumentList ${fix.args.map((a) => `'${a}'`).join(',')} -Verb RunAs -Wait -PassThru; exit $p.ExitCode`
      ]
    : fix.args

  return new Promise((resolve) => {
    execFile(file, args, { timeout: 15 * 60_000, windowsHide: true, encoding: 'buffer' }, (err, stdout, stderr) => {
      if (!err) {
        resolve({ ok: true, afterward: fix.afterward })
        return
      }

      const text = Buffer.concat([stdout as Buffer, stderr as Buffer]).toString('utf8').trim()
      // Cancelling the UAC prompt is a choice, not a failure to explain away.
      const cancelled = /1223|operation was canceled/i.test(text + String(err))
      resolve({
        ok: false,
        error: cancelled
          ? 'Cancelled at the Windows permission prompt. Nothing was changed.'
          : text.split('\n').slice(-4).join('\n') || 'The command did not complete.'
      })
    })
  })
}
