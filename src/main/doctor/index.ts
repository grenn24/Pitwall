import { chooseTargetDistro, defaultWslVersion, listDistros, wslPresent } from './wsl'
import { wslExec } from '../wsl/exec'
import type { CheckResult, DoctorReport } from '../../shared/doctor'

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
      remediation: 'Run "wsl --install" in an admin PowerShell, then restart Windows.',
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
      remediation: 'Run "wsl --set-default-version 2". Existing distros also need "wsl --set-version <name> 2".',
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
      remediation: 'Install one with "wsl --install -d Ubuntu". Worktrees cannot live in Docker Desktop\'s distros — they are reset on upgrade.',
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
  // The only answer that matters is whether the daemon responds to the distro
  // that will actually be starting containers.
  const dockerProbe = await wslExec(
    target.name,
    'docker version --format "{{.Client.Version}}|{{.Server.Version}}|{{.Server.Os}}"',
    20_000
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
    const notInstalled = /command not found/i.test(dockerProbe.stderr + dockerProbe.stdout)
    checks.push({
      id: 'docker',
      label: 'Docker daemon',
      status: 'fail',
      detail: notInstalled
        ? `Not available inside ${target.name}.`
        : 'Installed, but the daemon is not responding.',
      remediation: notInstalled
        ? `Install Docker Desktop, then enable WSL integration for ${target.name} in Settings → Resources → WSL Integration.`
        : 'Start Docker Desktop and wait for it to report "Engine running".',
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

function finish(checks: CheckResult[], targetDistro: string | null, started: number): DoctorReport {
  return {
    checks,
    targetDistro,
    ready: checks.every((c) => c.status === 'ok'),
    elapsedMs: Date.now() - started
  }
}

export type { CheckResult, DoctorReport } from '../../shared/doctor'
