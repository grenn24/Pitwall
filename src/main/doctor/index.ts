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

  // 1 — Is WSL there at all?
  if (!(await wslPresent())) {
    checks.push({
      id: 'wsl',
      label: 'Windows Subsystem for Linux',
      status: 'fail',
      detail: 'Not installed, or not responding.',
      remediation: 'Windows needs the WSL2 platform installed, then a restart.',
      fixId: 'wsl-install',
      docsUrl: DOCS.wsl
    })
    return finish(checks, null, started)
  }
  checks.push({ id: 'wsl', label: 'Windows Subsystem for Linux', status: 'ok', detail: 'Installed.' })

  // 2 — WSL 2 specifically. Version 1 cannot run the Docker integration.
  const { version, raw: statusRaw } = await defaultWslVersion()
  if (version === 2) {
    checks.push({ id: 'wslVersion', label: 'WSL 2 is the default', status: 'ok', detail: 'Default version 2.', raw: statusRaw })
  } else {
    checks.push({
      id: 'wslVersion',
      label: 'WSL 2 is the default',
      status: version === 1 ? 'fail' : 'warn',
      detail: version === 1 ? 'Default version is 1.' : 'Could not read the default version.',
      remediation: 'Set the default, then convert any existing distribution with "wsl --set-version <name> 2".',
      fixId: 'wsl-default-v2',
      docsUrl: DOCS.wsl,
      raw: statusRaw
    })
  }

  // 3 — A real distro to put worktrees in.
  const { distros, raw: listRaw } = await listDistros()
  const target = chooseTargetDistro(distros)
  if (!target) {
    checks.push({
      id: 'distro',
      label: 'A Linux distribution',
      status: 'fail',
      detail:
        distros.length > 0
          ? `Only Docker Desktop's own distros are installed (${distros.map((d) => d.name).join(', ')}).`
          : 'No distributions installed.',
      fixId: 'distro-install',
      remediation:
        distros.length > 0
          ? 'The Docker Desktop distributions are reset on upgrade, so worktrees cannot live in them. Install a real one.'
          : 'Note that "wsl --install" on its own may set up the platform without installing any distribution.',
      docsUrl: DOCS.wsl,
      raw: listRaw
    })
    return finish(checks, null, started)
  }
  targetDistro = target.name
  checks.push({
    id: 'distro',
    label: 'A Linux distribution',
    status: target.state.toLowerCase().startsWith('run') ? 'ok' : 'warn',
    detail: `${target.name} (WSL ${target.version}, ${target.state.toLowerCase()})`,
    remediation: target.state.toLowerCase().startsWith('run') ? undefined : `Start it with "wsl -d ${target.name}".`,
    raw: listRaw
  })

  // 4 — Docker, checked from inside the distro.
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
      fixId: 'docker-install',
      remediation: `Docker Desktop provides the engine. Once installed, enable integration for ${target.name} under Settings → Resources → WSL Integration.`,
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
      fixId: 'docker-start',
      remediation: 'Docker Desktop is installed but not running.',
      docsUrl: DOCS.docker,
      raw: (dockerProbe.stdout + dockerProbe.stderr).trim()
    })
    return finish(checks, targetDistro, started)
  }

  // 5 — Compose v2. Preview environments are two containers, described together.
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
  { id: 'wsl', label: 'Windows Subsystem for Linux' },
  { id: 'wslVersion', label: 'WSL 2 is the default' },
  { id: 'distro', label: 'A Linux distribution' },
  { id: 'docker', label: 'Docker daemon' },
  { id: 'compose', label: 'Docker Compose v2' }
]

/** Mark the checks Pitwall can repair itself, from main's own command table. */
function annotateFixes(checks: CheckResult[]): CheckResult[] {
  return checks.map((check) => {
    if (check.status === 'ok' || check.status === 'pending') return check
    const fix = fixFor(check.fixId)
    return fix ? { ...check, command: fix.command, canFix: true, fixElevated: fix.elevated } : check
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
