import { run, wsl } from '../wsl/exec'
import type { DistroInfo } from '../../shared/doctor'

/**
 * Distros that exist to support Docker Desktop rather than to hold user code.
 * Never a candidate for worktrees — Docker resets them on upgrade.
 */
const INFRASTRUCTURE_DISTROS = new Set(['docker-desktop', 'docker-desktop-data'])

export async function wslPresent(): Promise<boolean> {
  const { code } = await wsl(['--status'], 8_000)
  return code === 0
}

/**
 * Default WSL version, from `wsl --status`.
 *
 * Parsed loosely on purpose. The label is localized, so matching the English
 * words would break on a non-English Windows install; the number after the last
 * colon on a line is stable across locales.
 */
export async function defaultWslVersion(): Promise<{ version: number | null; raw: string }> {
  const { stdout } = await wsl(['--status'], 8_000)
  const raw = stdout.trim()
  const match = raw.match(/:\s*([12])\s*$/m)
  return { version: match ? Number(match[1]) : null, raw }
}

/**
 * Installed distros, from `wsl --list --verbose`.
 *
 * The header row is localized and the columns are space-padded, so this reads
 * positionally: the default distro carries a leading asterisk, and the trailing
 * token is always the WSL version number.
 */
export async function listDistros(): Promise<{ distros: DistroInfo[]; raw: string }> {
  const { stdout } = await wsl(['--list', '--verbose'], 10_000)
  const raw = stdout.trim()
  const distros: DistroInfo[] = []

  for (const line of raw.split(/\r?\n/).slice(1)) {
    const trimmed = line.trim()
    if (!trimmed) continue

    const isDefault = trimmed.startsWith('*')
    const parts = trimmed
      .replace(/^\*\s*/, '')
      .split(/\s{1,}/)
      .filter(Boolean)
    if (parts.length < 3) continue

    const version = Number(parts[parts.length - 1])
    const state = parts[parts.length - 2]
    const name = parts.slice(0, parts.length - 2).join(' ')
    if (!name || !Number.isFinite(version)) continue

    distros.push({ name, state, version, isDefault })
  }

  return { distros, raw }
}

/**
 * Pick the distro to hold worktrees.
 *
 * Prefers the user's default, as long as it is a real distro and not one of
 * Docker Desktop's own.
 */
export function chooseTargetDistro(distros: DistroInfo[]): DistroInfo | null {
  const usable = distros.filter(
    (d) => d.version === 2 && !INFRASTRUCTURE_DISTROS.has(d.name.toLowerCase())
  )
  if (usable.length === 0) return null
  return usable.find((d) => d.isDefault) ?? usable[0]
}

export { INFRASTRUCTURE_DISTROS }

/**
 * Whether Windows is holding a servicing change until the next restart.
 *
 * Read from the registry rather than through DISM, which needs elevation. This
 * is what separates "WSL was never installed" from "WSL was installed a minute
 * ago and Windows has not rebooted", two states that look identical to
 * `wsl --status` and have completely different answers.
 */
export async function rebootPending(): Promise<boolean> {
  const keys = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired'
  ]

  for (const key of keys) {
    const { code } = await run('reg.exe', ['query', key], 8_000)
    if (code === 0) return true
  }

  // A rename queued for the next boot is the other reliable signal.
  const pendingRenames = await run(
    'reg.exe',
    ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager', '/v', 'PendingFileRenameOperations'],
    8_000
  )
  return pendingRenames.code === 0
}
