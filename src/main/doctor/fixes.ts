import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { decodeWslOutput } from '../wsl/exec'
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

/**
 * Append-only record of what this module actually did.
 *
 * Kept because reasoning about this path from the outside failed four times.
 * The files a run leaves behind cannot distinguish "never happened" from
 * "happened and was cleaned up", so the app writes down what it saw.
 *
 * Never deleted, and never contains anything but our own paths and timings.
 */
export const DIAG_PATH = join(tmpdir(), 'pitwall-fix-diagnostics.log')

function diag(line: string): void {
  try {
    appendFileSync(DIAG_PATH, `${new Date().toISOString()}  ${line}
`, 'utf8')
  } catch {
    // Diagnostics must never be the reason something fails.
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
  return runViaScript(fix, true, onProgress)
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

/**
 * Run an elevated fix with no visible console.
 *
 * Two traps, both hit in real use.
 *
 * A Windows console has QuickEdit on by default, so one click inside it
 * suspends the process — the title gains the word "Select" and nothing else
 * happens, which is indistinguishable from a slow install. So the window is
 * hidden and output is teed to a log we poll.
 *
 * And completion cannot rest on Start-Process -Wait. Between UAC, a hidden
 * window and a nested elevation, a wait that never returns leaves the UI
 * claiming work is still running long after it finished. The generated script
 * therefore writes its own exit code into the log as its last act, and whichever
 * signal arrives first — the sentinel or the wait — ends the run.
 */
export function runViaScript(
  fix: Fix,
  elevate: boolean,
  onProgress?: (text: string) => void
): Promise<FixOutcome> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const logPath = join(tmpdir(), `pitwall-fix-${stamp}.log`)
  const donePath = join(tmpdir(), `pitwall-fix-${stamp}.done`)
  const scriptPath = join(tmpdir(), `pitwall-fix-${stamp}.ps1`)

  const psArgs = fix.args.map((a) => `'${a}'`).join(',')
  writeFileSync(
    scriptPath,
    [
      "$ErrorActionPreference = 'Continue'",
      // Appended line by line rather than piped to Out-File.
      //
      // Out-File buffers the whole pipeline and only writes when the command
      // finishes, so an 80-second install produced an empty log for 80 seconds
      // and looked indistinguishable from a hang. Add-Content per line flushes
      // as output arrives.
      //
      // Not Tee-Object either: it writes UTF-16LE in Windows PowerShell, which
      // reads back with a NUL between every character.
      `& '${fix.file}' @(${psArgs}) *>&1 | ForEach-Object { Add-Content -Path '${logPath}' -Encoding utf8 -Value $_ }`,
      '$code = $LASTEXITCODE',
      'if ($null -eq $code) { $code = 0 }',
      // Completion is signalled by a separate one-line file rather than a
      // marker inside the log. The log is held open by the redirection while
      // the command runs and carries whatever encoding the tool chose; a
      // dedicated file has neither problem and needs no parsing.
      `Set-Content -Path '${donePath}' -Encoding ascii -Value $code`,
      'exit $code'
    ].join('\r\n'),
    'utf8'
  )

  diag(`start ${fix.command} elevate=${elevate} script=${scriptPath}`)

  return new Promise((resolve) => {
    let settled = false
    let lastText = ''
    let lastChange = Date.now()
    let polls = 0

    const cleanup = (keepLog: boolean): void => {
      clearInterval(poll)
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
      diag(`done ok=${outcome.ok} polls=${polls} error=${outcome.error ?? ''}`)
      // A failed run keeps its log, and the message says where it is. Guessing
      // twice at why something hung is what made that necessary.
      cleanup(!outcome.ok)
      resolve(outcome.ok ? outcome : { ...outcome, error: `${outcome.error}

Full output: ${logPath}` })
    }

    const readLog = (): string => {
      try {
        // Sniffed, not assumed. Some Windows tools write UTF-16 whatever the
        // redirection asked for, and a NUL between every character is easy to
        // miss in a log yet fatal to a string search.
        return decodeWslOutput(readFileSync(logPath)).replace(/^\uFEFF/, '')
      } catch {
        return ''
      }
    }

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
          // Written but not yet readable; treat as success and let the re-probe
          // be the judge of what actually changed.
        }
        onProgress?.(text)
        done(
          code === 0
            ? { ok: true, afterward: fix.afterward, needsRestart: fix.needsRestart }
            : { ok: false, error: explain(text, `exit ${code}`) }
        )
        return
      }

      if (text && text !== lastText) {
        lastText = text
        lastChange = Date.now()
        onProgress?.(text)
        return
      }

      // Say so rather than showing a spinner that means nothing. A nested VM can
      // genuinely take this long, and silence is the only thing worth flagging.
      const stalledFor = Math.round((Date.now() - lastChange) / 1000)
      if (stalledFor >= 180 && stalledFor % 30 < 1) {
        onProgress?.(`${lastText}\n\n[still running — no new output for ${Math.round(stalledFor / 60)} min]
[log: ${logPath}]`)
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
          done({ ok: true, afterward: fix.afterward, needsRestart: fix.needsRestart })
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
  if (/is not recognized|ENOENT/i.test(blob)) {
    return 'winget is not available on this machine. Install Docker Desktop from docker.com instead.'
  }
  return text.trim().split('\n').slice(-4).join('\n') || 'The command did not complete.'
}
