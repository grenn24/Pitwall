import { execFile } from 'node:child_process'

/**
 * The single seam between the Windows UI and everything that runs in Linux.
 *
 * Today every call spawns wsl.exe. When the run engine becomes a daemon living
 * inside the distro, this is the one module that changes: the signatures stay,
 * the transport becomes RPC. Nothing above here should ever spawn a process on
 * its own.
 */

export interface RunResult {
  code: number
  stdout: string
  stderr: string
  /** Wall-clock milliseconds. WSL2 filesystem cost is the headline risk, so it is always measured. */
  elapsedMs: number
}

export class WslError extends Error {
  constructor(
    message: string,
    readonly result: RunResult
  ) {
    super(message)
    this.name = 'WslError'
  }
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
    if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le', 2).replace(/\0+$/, '')

    let nulAtOdd = 0
    const sample = Math.min(buf.length, 64)
    for (let i = 1; i < sample; i += 2) if (buf[i] === 0x00) nulAtOdd++
    if (nulAtOdd > sample / 4) return buf.toString('utf16le').replace(/\0+$/, '')
  }
  return buf.toString('utf8')
}

/**
 * Quote a value for use inside a bash command string.
 *
 * Every in-distro command is composed as text and handed to `bash -lc`, so this
 * is the only thing standing between a repository URL and arbitrary command
 * execution. Single quotes disable every expansion bash has; the only character
 * needing care is the single quote itself.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function spawn(file: string, args: string[], timeoutMs: number): Promise<RunResult> {
  const started = Date.now()
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, encoding: 'buffer', windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as { code?: unknown }).code === 'number'
            ? (err as unknown as { code: number }).code
            : err
              ? 1
              : 0
        resolve({
          code,
          stdout: decodeWslOutput(stdout as Buffer),
          stderr: decodeWslOutput(stderr as Buffer),
          elapsedMs: Date.now() - started
        })
      }
    )
  })
}

/** Run a wsl.exe management command (--status, --list, and friends). */
export function wsl(args: string[], timeoutMs = 15_000): Promise<RunResult> {
  return spawn('wsl.exe', args, timeoutMs)
}

/**
 * Run a command inside a distro as a login shell.
 *
 * Login shell matters: Docker Desktop's WSL integration puts `docker` on the
 * PATH through profile scripts, so a non-login shell reports it missing on a
 * machine where it works perfectly.
 */
export function wslExec(distro: string, command: string, timeoutMs = 60_000): Promise<RunResult> {
  return spawn('wsl.exe', ['-d', distro, '-e', 'bash', '-lc', command], timeoutMs)
}

/** Like wslExec, but a non-zero exit is an exception carrying the output. */
export async function wslExecOrThrow(distro: string, command: string, timeoutMs?: number): Promise<RunResult> {
  const result = await wslExec(distro, command, timeoutMs)
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().split('\n').slice(-4).join('\n')
    throw new WslError(detail || `Command failed with exit code ${result.code}`, result)
  }
  return result
}
