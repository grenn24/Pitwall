import { execFile } from 'node:child_process'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { FixId, FixOutcome } from '../../shared/doctor'

/**
 * Commands Pitwall will run on the user's behalf.
 *
 * A fixed table. The renderer asks for a fix id and never supplies a command —
 * if the UI could hand this module a string to run with elevation, one injected
 * script in the renderer would own the machine. Every entry below is a constant;
 * nothing here interpolates a value from the environment or the UI.
 *
 * Installing Docker goes through winget rather than fetching an installer
 * ourselves. That matters: winget is the OS's own package manager, its manifests
 * are signed and hash-verified, and the command is the same one a person would
 * type. Pitwall downloading an executable from a URL and running it elevated
 * would be a different thing entirely, and is not something this app does.
 */

export interface Fix {
  /** Shown before running, so the user sees exactly what they are agreeing to. */
  command: string
  /** True when the change only takes effect after Windows restarts. */
  needsRestart?: boolean
  file: string
  args: string[]
  /** True when Windows will show a UAC prompt. */
  elevated: boolean
  /** What to expect afterwards. */
  afterward?: string
}

const WINGET_DOCKER = [
  'install',
  '--id',
  'Docker.DockerDesktop',
  '-e',
  '--accept-package-agreements',
  '--accept-source-agreements'
]

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
    command: 'wsl --install',
    file: 'wsl.exe',
    args: ['--install'],
    elevated: true,
    needsRestart: true,
    afterward: 'Installed. Windows has to restart before Pitwall can see it.'
  },
  'wsl-default-v2': {
    command: 'wsl --set-default-version 2',
    file: 'wsl.exe',
    args: ['--set-default-version', '2'],
    elevated: true
  },
  'distro-install': {
    command: 'wsl --install -d Ubuntu',
    file: 'wsl.exe',
    args: ['--install', '-d', 'Ubuntu'],
    // Installing a distribution has not needed elevation since store-based WSL
    // shipped, and asking anyway trains people to click through UAC unread.
    elevated: false,
    afterward: 'Ubuntu will ask you to choose a username and password.'
  },
  'docker-install': {
    command: `winget ${WINGET_DOCKER.join(' ')}`,
    file: 'winget.exe',
    args: WINGET_DOCKER,
    elevated: true,
    afterward:
      'Docker Desktop is installed. Start it, and if it does not pick up your distribution automatically, enable it under Settings → Resources → WSL Integration.'
  },
  'docker-start': {
    command: 'Start Docker Desktop',
    file: 'powershell.exe',
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "Start-Process -FilePath \"$env:ProgramFiles\\Docker\\Docker\\Docker Desktop.exe\""
    ],
    elevated: false,
    afterward: 'Docker Desktop is starting. It takes a moment to report "Engine running".'
  }
}

export function fixFor(id: FixId | undefined): Fix | undefined {
  return id ? FIXES[id] : undefined
}

/**
 * Run a fix and report how it went.
 *
 * Elevated commands go through Start-Process -Verb RunAs, which is what raises
 * the UAC dialog. Their output is not capturable — the elevated process gets its
 * own console — so those report only an exit code and the doctor re-runs
 * afterwards. That is the honest signal anyway: what matters is the state of the
 * machine, not what a command claimed about itself.
 */
export function runFix(id: FixId, onProgress?: (text: string) => void): Promise<FixOutcome> {
  const fix = fixFor(id)
  if (!fix) return Promise.resolve({ ok: false, error: 'No fix is defined for this check.' })

  if (!fix.elevated) return runPlain(fix)
  return runElevated(fix, onProgress)
}

function runPlain(fix: Fix): Promise<FixOutcome> {
  return new Promise((resolve) => {
    execFile(fix.file, fix.args, { timeout: 30 * 60_000, windowsHide: true, encoding: 'buffer' }, (err, out, errOut) => {
      if (!err) {
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
 * The obvious approach — Start-Process -Verb RunAs and let the child have its
 * own console — has a trap that cost a real install: Windows consoles enable
 * QuickEdit by default, so a single click inside the window puts it in selection
 * mode and *suspends the process*. It looks identical to a slow install, and it
 * never finishes.
 *
 * So the window is hidden and output is teed to a log file we poll instead.
 * Progress ends up in our own UI, where a stray click cannot stop anything.
 *
 * The command runs from a generated script rather than an inline -Command
 * string. Elevation cannot be combined with output redirection on Start-Process,
 * and composing the equivalent inline means three levels of nested quoting —
 * a file sidesteps both problems.
 */
function runElevated(fix: Fix, onProgress?: (text: string) => void): Promise<FixOutcome> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const logPath = join(tmpdir(), `pitwall-fix-${stamp}.log`)
  const scriptPath = join(tmpdir(), `pitwall-fix-${stamp}.ps1`)

  const psArgs = fix.args.map((a) => `'${a}'`).join(',')
  writeFileSync(
    scriptPath,
    [
      "$ErrorActionPreference = 'Continue'",
      `& '${fix.file}' @(${psArgs}) *>&1 | Tee-Object -FilePath '${logPath}'`,
      'exit $LASTEXITCODE'
    ].join('\r\n'),
    'utf8'
  )

  let lastSent = ''
  const poll = setInterval(() => {
    try {
      const text = readFileSync(logPath, 'utf8').trim()
      if (text && text !== lastSent) {
        lastSent = text
        onProgress?.(text)
      }
    } catch {
      // The log does not exist until the elevated process creates it.
    }
  }, 700)

  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$p = Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${scriptPath}' -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode`
      ],
      { timeout: 30 * 60_000, windowsHide: true, encoding: 'buffer' },
      (err, out, errOut) => {
        clearInterval(poll)
        let log = ''
        try {
          log = readFileSync(logPath, 'utf8')
        } catch {
          // Nothing was written; the prompt was probably declined.
        }
        try {
          unlinkSync(scriptPath)
          unlinkSync(logPath)
        } catch {
          // Best effort. A stray file in temp is not worth failing over.
        }

        if (!err) {
          resolve({ ok: true, afterward: fix.afterward, needsRestart: fix.needsRestart })
          return
        }
        resolve({ ok: false, error: explain(log + Buffer.concat([out as Buffer, errOut as Buffer]).toString('utf8'), err) })
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
  if (/is not recognized|ENOENT/i.test(blob)) {
    return 'winget is not available on this machine. Install Docker Desktop from docker.com instead.'
  }
  return text.trim().split('\n').slice(-4).join('\n') || 'The command did not complete.'
}
