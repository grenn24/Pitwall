import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { app, safeStorage } from 'electron'

/**
 * Where the GitHub token lives between launches.
 *
 * Encrypted by Electron's safeStorage, which on Windows uses DPAPI — the same
 * mechanism Credential Manager uses. The ciphertext is bound to the Windows
 * user account, so copying the file to another machine or another user yields
 * nothing.
 *
 * If encryption is unavailable, the token is not written at all. A plaintext
 * token on disk is worse than making someone sign in again: it is a credential
 * with write access to their repositories, sitting in a file any process can
 * read.
 */

const FILE = (): string => join(app.getPath('userData'), 'github-token.bin')

export function canPersist(): boolean {
  return safeStorage.isEncryptionAvailable()
}

export function saveToken(token: string): { saved: boolean; reason?: string } {
  if (!canPersist()) {
    return {
      saved: false,
      reason:
        'Windows would not provide encryption for stored credentials, so the sign-in was not saved. You will be asked to sign in again next time.'
    }
  }

  try {
    const path = FILE()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, safeStorage.encryptString(token))
    return { saved: true }
  } catch (error) {
    return { saved: false, reason: `The sign-in could not be saved (${(error as Error).message}).` }
  }
}

/**
 * The stored token, or null.
 *
 * Every failure returns null rather than throwing. A token that cannot be read
 * — corrupt file, different Windows user, encryption unavailable — is
 * indistinguishable from no token at all, and both mean the same thing: sign
 * in again.
 */
export function loadToken(): string | null {
  try {
    const path = FILE()
    if (!existsSync(path)) return null
    if (!canPersist()) return null
    const token = safeStorage.decryptString(readFileSync(path))
    return token.length > 0 ? token : null
  } catch {
    return null
  }
}

export function clearToken(): void {
  try {
    const path = FILE()
    if (existsSync(path)) unlinkSync(path)
  } catch {
    // Signing out must never fail. A token that cannot be deleted is still
    // useless once the app stops using it, and the next save overwrites it.
  }
}
