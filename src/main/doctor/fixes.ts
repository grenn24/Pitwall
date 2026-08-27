import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { decodeWslOutput } from '../wsl/exec'
import { wslExec } from '../wsl/exec'
import { writeState } from '../state'
import { chooseTargetDistro, defaultWslVersion, listDistros, wslPresent } from './wsl'
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
  /** Recorded when the fix succeeds, for facts the machine cannot report. */
  onSuccess?: () => void
  file: string
  args: string[]
  /** True when Windows will show a UAC prompt. */
  elevated: boolean
  /**
   * True when the command needs to talk to the user.
   *
   * These run in a visible console and are not waited on. Ubuntu's first run
   * asks for a username and password; with the window hidden that prompt has
   * nowhere to appear, and the command sits there having apparently succeeded
   * while nothing happens. Completion comes from `landed` instead.
   */
  /**
   * Build the arguments once the target distribution is known.
   *
   * Used by the few fixes that act inside a distribution. The name is
   * validated before use and reaches the process as an argv element, never
   * through a shell.
   */
  argsFor?: (distro: string) => string[]
  interactive?: boolean
  /** What to expect afterwards. */
  afterward?: string
  /**
   * What to say while it runs.
   *
   * Some of these commands produce almost no output. DISM writes its progress
   * as a percentage it overwrites in place, never finishing a line, so a
   * line-oriented capture receives the banner and then silence for minutes.
   * Saying so is better than an empty box that looks like a hang.
   */
  whileRunning?: string
  /**
   * Has this fix taken effect on the machine?
   *
   * The primary completion signal, polled while the command runs. Exit
   * codes, marker files and log output are all proxies for this question,
   * and every one of them has failed in practice: a console that suspends
   * on a click, a wait that never returns, a log in the wrong encoding,
   * output a tool refuses to flush. The state of the machine cannot lie
   * about any of them.
   */
  landed?: () => Promise<boolean>
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
    whileRunning: 'Installing the WSL2 platform. This usually takes one to three minutes and prints almost nothing while it works.',
    // Enabling the optional components sets a pending-reboot flag, which is the
    // observable moment the install finished. WSL itself cannot work until the
    // restart, so waiting for it to answer would wait forever.
    // Enabling the components cannot be observed directly, so this one is
    // settled by the process rather than by machine state.
    landed: async () => wslPresent(),
    onSuccess: () => writeState({ wslInstalledAt: new Date().toISOString() }),
    afterward: 'Installed. Windows has to restart before Pitwall can see it.'
  },
  'wsl-default-v2': {
    command: 'wsl --set-default-version 2',
    file: 'wsl.exe',
    args: ['--set-default-version', '2'],
    elevated: true,
    landed: async () => (await defaultWslVersion()).version === 2
  },
  'distro-install': {
    command: 'wsl --install -d Ubuntu',
    file: 'wsl.exe',
    args: ['--install', '-d', 'Ubuntu'],
    // Installing a distribution has not needed elevation since store-based WSL
    // shipped, and asking anyway trains people to click through UAC unread.
    elevated: false,
    interactive: true,
    whileRunning:
      'A terminal window is open. Choose a username and password for Ubuntu there — this window will catch up on its own.',
    afterward: 'Ubuntu is installed and ready.',
    landed: async () => chooseTargetDistro((await listDistros()).distros) !== null
  },
  'distro-git': {
    command: 'sudo apt-get install -y git',
    file: 'wsl.exe',
    args: [],
    argsFor: (distro) => ['-d', distro, '--', 'bash', '-lc', 'sudo apt-get update && sudo apt-get install -y git'],
    elevated: false,
    // apt asks for a sudo password, so this one needs a window and a person.
    interactive: true,
    whileRunning: 'A terminal window is open. Enter your Linux password there to install git.',
    afterward: 'Git is installed inside the distribution.',
    landed: () => distroHas('git')
  },
  'docker-install': {
    command: `winget ${WINGET_DOCKER.join(' ')}`,
    file: 'winget.exe',
    args: WINGET_DOCKER,
    elevated: true,
    whileRunning: 'Downloading and installing Docker Desktop. This is a large download and can take several minutes.',
    landed: () => dockerAnswers('command -v docker >/dev/null 2>&1 && echo yes'),
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
    afterward: 'Docker Desktop is starting. It takes a moment to report "Engine running".',
    landed: () => dockerAnswers('docker version --format "{{.Server.Os}}" >/dev/null 2>&1 && echo yes')
  }
}

/** True when the named tool exists inside the usable distribution. */
export async function distroHas(tool: string): Promise<boolean> {
  return dockerAnswers(`command -v ${tool} >/dev/null 2>&1 && echo yes`)
}

/** True when the given probe answers "yes" inside the usable distribution. */
async function dockerAnswers(command: string): Promise<boolean> {
  const { distros } = await listDistros()
  const target = chooseTargetDistro(distros)
  if (!target) return false
  const result = await wslExec(target.name, `${command} || echo no`, 30_000)
  return result.stdout.trim().split(/\r?\n/).pop() === 'yes'
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
/**
 * Distribution names that are safe to hand to a process.
 *
 * Names come from parsing `wsl --list`, not from the user, but they still cross
 * into argument lists — so they are checked rather than trusted. Anything with
 * a quote, a shell metacharacter or a newline in it is refused.
 */
const SAFE_DISTRO = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/

export function runFix(id: FixId, onProgress?: (text: string) => void): Promise<FixOutcome> {
  const base = fixFor(id)
  if (!base) return Promise.resolve({ ok: false, error: 'No fix is defined for this check.' })
  return resolveArgs(base).then((fix) => {
    if (!fix) {
      return {
        ok: false,
        error: 'No usable Linux distribution to run this in.'
      } satisfies FixOutcome
    }
    return dispatch(fix, onProgress)
  })
}

/** Bind a distribution-scoped fix to the distribution it will act on. */
async function resolveArgs(fix: Fix): Promise<Fix | null> {
  if (!fix.argsFor) return fix

  const target = chooseTargetDistro((await listDistros()).distros)
  if (!target || !SAFE_DISTRO.test(target.name)) return null
  return { ...fix, args: fix.argsFor(target.name) }
}

function dispatch(fix: Fix, onProgress?: (text: string) => void): Promise<FixOutcome> {

  if (fix.interactive) return runInteractive(fix)
  if (!fix.elevated) return runPlain(fix)
  return runViaScript(fix, true, onProgress)
}

/**
 * Launch a command in a console the user can actually use.
 *
 * Two things this has to get right, both learned the hard way.
 *
 * The window has to survive the command. Launching the executable directly
 * gives it a console that closes the instant it exits, so a command that fails
 * in half a second shows a flash and nothing else — no error, no output, no
 * clue. The generated script waits for a keypress at the end, so whatever
 * happened is still on screen.
 *
 * And it is not waited on. This one is waiting on a person; the machine-state
 * poll reports when the world actually changed.
 */
export function buildInteractiveScript(fix: Fix): string {
  const psArgs = fix.args.map((a) => `'${a.replaceAll("'", "''")}'`).join(',')
  return [
      "$Host.UI.RawUI.WindowTitle = 'Pitwall — setup'",
      `Write-Host "Running: ${fix.command.replaceAll('"', '`"')}" -ForegroundColor Cyan`,
      'Write-Host ""',
      "$ErrorActionPreference = 'Continue'",
      `& '${fix.file}' @(${psArgs})`,
      'Write-Host ""',
      'if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) {',
      '  Write-Host "The command exited with code $LASTEXITCODE." -ForegroundColor Yellow',
      '} else {',
      '  Write-Host "Finished. You can close this window." -ForegroundColor Green',
      '}',
      'Write-Host "Press Enter to close."',
      '[void](Read-Host)'
  ].join('\r\n')
}

function runInteractive(fix: Fix): Promise<FixOutcome> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const scriptPath = join(tmpdir(), `pitwall-interactive-${stamp}.ps1`)
  writeFileSync(scriptPath, buildInteractiveScript(fix), 'utf8')

  diag(`interactive launch ${fix.command} script=${scriptPath}`)

  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${scriptPath}' -WindowStyle Normal`
      ],
      { windowsHide: true, timeout: 60_000 },
      (err) => {
        // The script outlives this call, so it is cleaned up on a delay rather
        // than immediately — deleting it now would pull it out from under the
        // window that is about to read it.
        setTimeout(
          () => {
            try {
              unlinkSync(scriptPath)
            } catch {
              // Best effort.
            }
          },
          30 * 60_000
        ).unref()

        if (err) {
          resolve({ ok: false, error: `Could not open a terminal for this step. ${String(err).split('\n')[0]}` })
          return
        }
        resolve({ ok: true, afterward: fix.whileRunning, pending: true })
      }
    )
  })
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
    let checkingLanded = false

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

    // The machine-state check runs on its own slower cadence, since each one
    // shells into the distribution and is far from free.
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
