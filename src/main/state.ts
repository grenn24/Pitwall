import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * The small amount Pitwall has to remember between launches.
 *
 * Exists because of one question the machine cannot answer: whether WSL is
 * missing, or was installed a minute ago and is waiting for a restart. Three
 * registry signals were tried for it. The reboot flags are set on almost every
 * Windows machine permanently; LxssManager is absent even where WSL works; and
 * WslService and Lxss are present on a clean Windows 11, because wsl.exe now
 * ships with the OS. Each one produced a confident claim that was false.
 *
 * So the app records what it did instead of guessing what happened. The only
 * way it says "installed, waiting for a restart" is if it performed the install
 * itself.
 *
 * Plain JSON under the user's home directory rather than Electron's userData,
 * so the CLI scripts can read the same file without pulling in Electron.
 */

export interface PitwallState {
  /** When Pitwall last completed `wsl --install`, ISO 8601. */
  wslInstalledAt?: string
}

const STATE_PATH = join(homedir(), '.pitwall', 'state.json')

export function readState(): PitwallState {
  try {
    if (!existsSync(STATE_PATH)) return {}
    return JSON.parse(readFileSync(STATE_PATH, 'utf8')) as PitwallState
  } catch {
    // A corrupt state file must never stop the app starting. Losing it means
    // one wrong label on one check, which the next restart corrects anyway.
    return {}
  }
}

export function writeState(patch: Partial<PitwallState>): void {
  try {
    mkdirSync(dirname(STATE_PATH), { recursive: true })
    writeFileSync(STATE_PATH, JSON.stringify({ ...readState(), ...patch }, null, 2), 'utf8')
  } catch {
    // Best effort, for the same reason.
  }
}

export function clearState(keys: (keyof PitwallState)[]): void {
  try {
    const next = readState()
    for (const key of keys) delete next[key]
    mkdirSync(dirname(STATE_PATH), { recursive: true })
    writeFileSync(STATE_PATH, JSON.stringify(next, null, 2), 'utf8')
  } catch {
    // As above.
  }
}

export { STATE_PATH }
