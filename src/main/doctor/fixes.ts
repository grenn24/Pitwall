import { execFile } from 'node:child_process'

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
export function runFix(id: FixId): Promise<FixOutcome> {
  const fix = fixFor(id)
  if (!fix) return Promise.resolve({ ok: false, error: 'No fix is defined for this check.' })

  const file = fix.elevated ? 'powershell.exe' : fix.file
  const args = fix.elevated
    ? [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$p = Start-Process -FilePath '${fix.file}' -ArgumentList ${fix.args
          .map((a) => `'${a}'`)
          .join(',')} -Verb RunAs -Wait -PassThru; exit $p.ExitCode`
      ]
    : fix.args

  return new Promise((resolve) => {
    // Generous: a Docker Desktop install over winget is a large download.
    execFile(file, args, { timeout: 30 * 60_000, windowsHide: true, encoding: 'buffer' }, (err, stdout, stderr) => {
      if (!err) {
        resolve({ ok: true, afterward: fix.afterward, needsRestart: fix.needsRestart })
        return
      }

      const text = Buffer.concat([stdout as Buffer, stderr as Buffer]).toString('utf8').trim()
      const blob = text + String(err)

      // Declining the permission prompt is a choice, not a failure to explain.
      if (/1223|operation was canceled/i.test(blob)) {
        resolve({ ok: false, error: 'Cancelled at the Windows permission prompt. Nothing was changed.' })
        return
      }
      // winget is present on current Windows 11 but not on every machine.
      if (/is not recognized|ENOENT/i.test(blob)) {
        resolve({
          ok: false,
          error: 'winget is not available on this machine. Install Docker Desktop from docker.com instead.'
        })
        return
      }

      resolve({ ok: false, error: text.split('\n').slice(-4).join('\n') || 'The command did not complete.' })
    })
  })
}
