import { clearState, readState } from '../state'
import { chooseTargetDistro, defaultWslVersion, listDistros, wslPresent } from './wsl'
import { wslExec } from '../wsl/exec'
import { fixFor } from './fixes'
import type { CheckId, CheckResult, DoctorReport } from '../../shared/doctor'

const DOCS = {
  wsl: 'https://learn.microsoft.com/windows/wsl/install',
  docker: 'https://docs.docker.com/desktop/wsl/'
}

/**
 * Probe the machine and report what is missing.
 *
 * Deliberately does not throw. A first-run screen that crashes because the thing
 * it is checking for is absent is worse than useless, so every failure path ends
 * in a CheckResult with a remediation string.
 */
export async function runDoctor(): Promise<DoctorReport> {
  const started = Date.now()
  const checks: CheckResult[] = []
  let targetDistro: string | null = null

  // 1 — WSL2 with a distribution, as one question.
  //
  // Deliberately not three checks. The platform, the default version and the
  // distribution are not independent: `wsl --install` provides all three, and
  // none of them are real until Windows restarts. Reporting them separately
  // invited fixing them separately, which is how someone ends up installing a
  // distribution onto a platform that has not been enabled yet.
  if (readState().wslInstalledAt && !(await wslPresent())) {
    checks.push({
      id: 'wsl',
      label: 'WSL2 with a Linux distribution',
      status: 'fail',
      detail: 'Installed. Windows has to restart before any of it works.',
      remediation: 'Nothing else can be checked until the machine has restarted.',
      fixId: 'restart-windows'
    })
    return finish(checks, null, started)
  }

  if (!(await wslPresent())) {
    checks.push({
      id: 'wsl',
      label: 'WSL2 with a Linux distribution',
      status: 'fail',
      detail: 'Not installed.',
      remediation: 'This installs the WSL2 platform and Ubuntu together, then restarts Windows.',
      fixId: 'wsl-install',
      docsUrl: DOCS.wsl
    })
    return finish(checks, null, started)
  }

  // WSL answers, so any record of an install waiting on a restart is spent.
  if (readState().wslInstalledAt) clearState(['wslInstalledAt'])

  const { version } = await defaultWslVersion()
  if (version === 1) {
    checks.push({
      id: 'wsl',
      label: 'WSL2 with a Linux distribution',
      status: 'fail',
      detail: 'WSL is installed, but version 1 is the default.',
      remediation: 'Version 1 cannot run the Docker integration.',
      fixId: 'wsl-default-v2',
      docsUrl: DOCS.wsl
    })
    return finish(checks, null, started)
  }

  const { distros, raw: listRaw } = await listDistros()
  const target = chooseTargetDistro(distros)
  if (!target) {
    checks.push({
      id: 'wsl',
      label: 'WSL2 with a Linux distribution',
      status: 'fail',
      detail:
        distros.length > 0
          ? `Only Docker Desktop's own distributions are present (${distros.map((d) => d.name).join(', ')}), and those are reset on upgrade.`
          : 'The platform is installed, but there is no Linux distribution.',
      remediation: 'This installs Ubuntu and restarts Windows.',
      fixId: 'wsl-install',
      docsUrl: DOCS.wsl,
      raw: listRaw
    })
    return finish(checks, null, started)
  }

  targetDistro = target.name
  checks.push({
    id: 'wsl',
    label: 'WSL2 with a Linux distribution',
    status: target.state.toLowerCase().startsWith('run') ? 'ok' : 'warn',
    detail: `${target.name} (WSL ${target.version}, ${target.state.toLowerCase()})`,
    remediation: target.state.toLowerCase().startsWith('run') ? undefined : `Start it with "wsl -d ${target.name}".`,
    raw: listRaw
  })

  // 2 — git, inside the distribution.
  //
  // Every clone and every worktree runs in there, so its absence is fatal to
  // the whole product — and a fresh WSL image does not always include it. Left
  // undetected it surfaces as a confusing failure inside a clone rather than a
  // check with an answer.
  const gitProbe = await wslExec(
    target.name,
    'command -v git >/dev/null 2>&1 && git --version || echo __MISSING__',
    60_000
  )
  const gitLine = gitProbe.stdout.trim().split(/\r?\n/).pop() ?? ''

  if (gitProbe.timedOut) {
    checks.push({
      id: 'git',
      label: 'Git inside the distribution',
      status: 'warn',
      detail: `${target.name} did not answer in time.`,
      remediation: `A distribution that has just been installed can be slow to start. Check again in a moment.`
    })
    return finish(checks, targetDistro, started)
  }

  if (gitLine === '__MISSING__' || !gitLine) {
    checks.push({
      id: 'git',
      label: 'Git inside the distribution',
      status: 'fail',
      detail: `Not installed inside ${target.name}.`,
      command: `wsl -d ${target.name} -- sudo apt-get update && sudo apt-get install -y git`,
      remediation:
        'Every clone and worktree runs inside the distribution, so git has to be there rather than on Windows. Run this in a terminal — it will ask for your Linux password.'
    })
    return finish(checks, targetDistro, started)
  }

  checks.push({ id: 'git', label: 'Git inside the distribution', status: 'ok', detail: gitLine })

  // 3 — Docker, checked from inside the distro.
  //
  // Not from Windows. `docker` resolves on the Windows PATH to a non-executable
  // stub on some machines, so a PATH lookup reports success where nothing runs.
  //
  // Existence is asked separately from health, because they have different
  // answers and different fixes. A freshly created distro can take twenty
  // seconds to answer its first login shell, and treating that silence as "the
  // daemon is down" tells someone to go restart software they never installed.
  const presence = await wslExec(target.name, 'command -v docker >/dev/null 2>&1 && echo present || echo absent', 90_000)

  if (presence.timedOut) {
    checks.push({
      id: 'docker',
      label: 'Docker daemon',
      status: 'warn',
      detail: `${target.name} did not answer in time, so Docker could not be checked.`,
      remediation: `A distribution that has just been installed can be slow to start. Give it a moment and check again, or open it once with "wsl -d ${target.name}".`,
      raw: presence.stdout + presence.stderr
    })
    return finish(checks, targetDistro, started)
  }

  if (presence.stdout.trim().split(/\r?\n/).pop() !== 'present') {
    checks.push({
      id: 'docker',
      label: 'Docker daemon',
      status: 'fail',
      detail: `Not installed inside ${target.name}.`,
      remediation: `Install Docker Desktop from docker.com, keeping "Use WSL 2 based engine" checked. Then open Settings → Resources → WSL Integration and enable ${target.name}.`,
      docsUrl: DOCS.docker,
      raw: (presence.stdout + presence.stderr).trim()
    })
    return finish(checks, targetDistro, started)
  }

  const dockerProbe = await wslExec(
    target.name,
    'docker version --format "{{.Client.Version}}|{{.Server.Version}}|{{.Server.Os}}"',
    30_000
  )
  const dockerLine = dockerProbe.stdout.trim().split(/\r?\n/).pop() ?? ''
  const [clientV, serverV, serverOs] = dockerLine.split('|')

  if (dockerProbe.code === 0 && serverV) {
    checks.push({
      id: 'docker',
      label: 'Docker daemon',
      status: serverOs === 'linux' ? 'ok' : 'warn',
      detail:
        serverOs === 'linux'
          ? `Engine ${serverV} (client ${clientV}), Linux containers.`
          : `Engine ${serverV}, but in ${serverOs} container mode.`,
      remediation: serverOs === 'linux' ? undefined : 'Switch Docker Desktop to Linux containers.',
      raw: dockerProbe.stdout
    })
  } else {
    // The client exists, so this really is a daemon that is not answering.
    checks.push({
      id: 'docker',
      label: 'Docker daemon',
      status: 'fail',
      detail: 'The Docker command is present, but the daemon is not responding.',
      remediation: 'Docker Desktop is installed but not running. Start it and wait for it to report "Engine running".',
      docsUrl: DOCS.docker,
      raw: (dockerProbe.stdout + dockerProbe.stderr).trim()
    })
    return finish(checks, targetDistro, started)
  }

  // 4 — Compose v2. Preview environments are two containers, described together.
  const composeProbe = await wslExec(target.name, 'docker compose version --short', 15_000)
  const composeVersion = composeProbe.stdout.trim().split(/\r?\n/).pop() ?? ''
  if (composeProbe.code === 0 && composeVersion) {
    checks.push({ id: 'compose', label: 'Docker Compose v2', status: 'ok', detail: `Compose ${composeVersion}.` })
  } else {
    checks.push({
      id: 'compose',
      label: 'Docker Compose v2',
      status: 'fail',
      detail: 'The "docker compose" subcommand is unavailable.',
      remediation: 'Update Docker Desktop. Compose v1 ("docker-compose") is not supported.',
      docsUrl: DOCS.docker,
      raw: (composeProbe.stdout + composeProbe.stderr).trim()
    })
  }

  return finish(checks, targetDistro, started)
}

/** Every check, in order, so a report can show the whole path. */
const ALL_CHECKS: { id: CheckId; label: string }[] = [
  { id: 'wsl', label: 'WSL2 with a Linux distribution' },
  { id: 'git', label: 'Git inside the distribution' },
  { id: 'docker', label: 'Docker daemon' },
  { id: 'compose', label: 'Docker Compose v2' }
]

/** Mark the checks Pitwall can repair itself, from main's own command table. */
function annotateFixes(checks: CheckResult[]): CheckResult[] {
  return checks.map((check) => {
    if (check.status === 'ok' || check.status === 'pending') return check
    const fix = fixFor(check.fixId)
    // A check without an automated fix keeps whatever command it set for
    // itself, so the user can still copy it rather than retype it.
    return fix
      ? { ...check, command: fix.command, canFix: true, fixElevated: fix.elevated, fixWhileRunning: fix.whileRunning }
      : check
  })
}

function finish(checks: CheckResult[], targetDistro: string | null, started: number): DoctorReport {
  // The probe stops at the first blocker, since later checks depend on earlier
  // ones. Pad the rest as pending rather than hiding them: someone looking at a
  // single failed row cannot tell whether they are one step from done or five.
  const reached = new Set(checks.map((c) => c.id))
  const padded = [
    ...checks,
    ...ALL_CHECKS.filter((c) => !reached.has(c.id)).map(
      ({ id, label }): CheckResult => ({ id, label, status: 'pending', detail: 'Not checked yet.' })
    )
  ]

  return {
    checks: annotateFixes(padded),
    targetDistro,
    ready: padded.every((c) => c.status === 'ok'),
    elapsedMs: Date.now() - started
  }
}

export type { CheckResult, DoctorReport } from '../../shared/doctor'
