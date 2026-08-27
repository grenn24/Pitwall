import { execFile } from 'node:child_process'

import type { DistroInfo } from '../../shared/doctor'

/**
 * Distros that exist to support Docker Desktop rather than to hold user code.
 * Never a candidate for worktrees.
 */
const INFRASTRUCTURE_DISTROS = new Set(['docker-desktop', 'docker-desktop-data'])

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * wsl.exe writes its *management* output (--status, --list) as UTF-16LE, while
 * anything it runs inside a distro comes back as the Linux process wrote it,
 * normally UTF-8. Decoding everything one way produces either mojibake or text
 * with a NUL between every character, and the second failure mode is easy to
 * miss because it still looks almost right in a log.
 *
 * Sniff instead of guessing: UTF-16LE ASCII has a NUL as every second byte.
 */
export function decodeWslOutput(buf: Buffer): string {
  if (buf.length >= 4) {
    // BOM is decisive when present.
    if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le', 2).replace(/\0+$/, '')

    let nulAtOdd = 0
    const sample = Math.min(buf.length, 64)
    for (let i = 1; i < sample; i += 2) if (buf[i] === 0x00) nulAtOdd++
    if (nulAtOdd > sample / 4) return buf.toString('utf16le').replace(/\0+$/, '')
  }
  return buf.toString('utf8')
}

function run(file: string, args: string[], timeoutMs = 15_000): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, encoding: 'buffer', windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          code: err && typeof (err as { code?: unknown }).code === 'number' ? (err as unknown as { code: number }).code : err ? 1 : 0,
          stdout: decodeWslOutput(stdout as Buffer),
          stderr: decodeWslOutput(stderr as Buffer)
        })
      }
    )
  })
}

/** Run a wsl.exe management command. */
export function wsl(args: string[], timeoutMs?: number): Promise<RunResult> {
  return run('wsl.exe', args, timeoutMs)
}

/**
 * Run a command inside a distro as a login shell.
 *
 * Login shell matters: Docker Desktop's WSL integration puts `docker` on the
 * PATH through profile scripts, so a non-login shell reports it missing on a
 * machine where it works perfectly.
 */
export function wslExec(distro: string, command: string, timeoutMs?: number): Promise<RunResult> {
  return run('wsl.exe', ['-d', distro, '-e', 'bash', '-lc', command], timeoutMs)
}

export async function wslPresent(): Promise<boolean> {
  const { code } = await wsl(['--status'], 8_000)
  return code === 0
}

/**
 * Default WSL version, from `wsl --status`.
 *
 * Parsed loosely on purpose. The label is localized, so matching the English
 * words would break on a non-English Windows install; the number after the last
 * colon on the line mentioning a version is stable across locales.
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
 * positionally: the default distro is marked with a leading asterisk, and the
 * trailing token is always the WSL version number.
 */
export async function listDistros(): Promise<{ distros: DistroInfo[]; raw: string }> {
  const { stdout } = await wsl(['--list', '--verbose'], 10_000)
  const raw = stdout.trim()
  const distros: DistroInfo[] = []

  for (const line of raw.split(/\r?\n/).slice(1)) {
    const trimmed = line.trim()
    if (!trimmed) continue

    const isDefault = trimmed.startsWith('*')
    const parts = trimmed.replace(/^\*\s*/, '').split(/\s{1,}/).filter(Boolean)
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
 * Docker Desktop's own. Infrastructure distros are filtered out entirely — a
 * worktree in docker-desktop would vanish on its next reset.
 */
export function chooseTargetDistro(distros: DistroInfo[]): DistroInfo | null {
  const usable = distros.filter((d) => d.version === 2 && !INFRASTRUCTURE_DISTROS.has(d.name.toLowerCase()))
  if (usable.length === 0) return null
  return usable.find((d) => d.isDefault) ?? usable[0]
}

export { INFRASTRUCTURE_DISTROS }
