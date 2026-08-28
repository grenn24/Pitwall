/**
 * Drive the GitHub device flow from a terminal.
 *
 *   npm run github          — start a sign-in and print the code
 *   npm run github -- check — verify the app id and device flow only
 *
 * No Electron, so this exercises the exchange itself without a window. The
 * token is printed as a fingerprint, never in full.
 */
import { requestDeviceCode, pollForToken, GitHubAuthError } from '../src/main/github/auth'
import { GITHUB_CLIENT_ID } from '../src/shared/github'

const checkOnly = process.argv.includes('check')

console.log(`\nclient id : ${GITHUB_CLIENT_ID}`)

try {
  const { code, deviceCode, interval } = await requestDeviceCode()
  console.log('device flow: enabled, GitHub issued a code\n')
  console.log(`  open  ${code.verificationUri}`)
  console.log(`  enter ${code.userCode}`)
  console.log(`  valid for ${Math.round(code.expiresIn / 60)} minutes, polling every ${interval}s\n`)

  if (checkOnly) {
    console.log('check only — not waiting for you to enter it\n')
    process.exit(0)
  }

  const token = await pollForToken({
    deviceCode,
    interval,
    expiresIn: code.expiresIn,
    onWaiting: (s) => process.stdout.write(`\r  waiting… ${s}s`)
  })

  process.stdout.write('\r' + ' '.repeat(40) + '\r')

  const who = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }
  }).then((r) => r.json() as Promise<{ login?: string; name?: string }>)

  console.log(`signed in as ${who.login ?? '(unknown)'}${who.name ? ` (${who.name})` : ''}`)
  console.log(`token      : ${token.slice(0, 8)}…${token.slice(-4)} (${token.length} chars)\n`)
} catch (error: unknown) {
  if (error instanceof GitHubAuthError) {
    console.error(`\nFAILED: ${error.message}${error.code ? `  [${error.code}]` : ''}\n`)
  } else {
    console.error(`\nFAILED: ${String(error)}\n`)
  }
  process.exit(1)
}
