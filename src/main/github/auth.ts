import { GITHUB_CLIENT_ID, type DeviceCode } from '../../shared/github'

/**
 * The GitHub device flow.
 *
 * Deliberately free of Electron, so the whole exchange can be driven from a
 * terminal without a window. Token storage lives next door in tokens.ts, which
 * is the part that needs Electron.
 *
 * The flow: ask GitHub for a code, show it to the user, then poll until they
 * have typed it in. GitHub decides the polling interval and will slow us down
 * if we ignore it, so the interval it returns is obeyed rather than guessed.
 */

const DEVICE_CODE_URL = 'https://github.com/login/device/code'
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token'

export class GitHubAuthError extends Error {
  constructor(
    message: string,
    /** GitHub's own error slug, when it gave one. */
    readonly code?: string
  ) {
    super(message)
    this.name = 'GitHubAuthError'
  }
}

/**
 * Turn a network failure into something worth reading.
 *
 * Node reports every transport problem as "TypeError: fetch failed" with the
 * real cause buried underneath, which tells a user nothing about whether to
 * retry, check their connection, or look at a proxy.
 */
export async function fetchOrExplain(url: string, init: RequestInit, what: string): Promise<Response> {
  try {
    return await fetch(url, init)
  } catch (error) {
    const cause = (error as { cause?: { code?: string; message?: string } }).cause
    const code = cause?.code ?? ''
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
      throw new GitHubAuthError(`Could not resolve github.com while trying to ${what}. Check the network connection.`)
    }
    if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') {
      throw new GitHubAuthError(`The connection to GitHub dropped while trying to ${what}. Try again.`)
    }
    if (code.includes('CERT') || code.includes('SELF_SIGNED')) {
      throw new GitHubAuthError(
        `The certificate GitHub presented was not trusted while trying to ${what}. ` +
          'This usually means antivirus or a proxy is inspecting HTTPS traffic.'
      )
    }
    if ((error as Error).name === 'TimeoutError') {
      throw new GitHubAuthError(`GitHub did not answer in time while trying to ${what}. Try again.`)
    }
    throw new GitHubAuthError(`Could not reach GitHub while trying to ${what}${code ? ` (${code})` : ''}.`)
  }
}

interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
}

/**
 * Turn GitHub's refusal into something the person reading it can act on.
 *
 * Each of these names a real setting on the app's own page, which saves
 * someone reading an OAuth specification to find out what went wrong.
 */
function startupMessage(status: number, error?: string): string {
  switch (error) {
    case 'device_flow_disabled':
      return 'Device flow is switched off for this GitHub App. Turn on "Enable Device Flow" on the app\'s General settings page, then try again.'
    case 'unauthorized_client':
      return 'GitHub does not recognise this app for device flow. Check the client id, and that device flow is enabled.'
    case 'incorrect_client_credentials':
      return 'That client id is not a GitHub App this account can use.'
    default:
      return `GitHub refused to start the sign-in (${status}${error ? ` ${error}` : ''}).`
  }
}

/** Start a sign-in. Returns what to show the user, and the handle to poll with. */
export async function requestDeviceCode(): Promise<{ code: DeviceCode; deviceCode: string; interval: number }> {
  const response = await fetchOrExplain(DEVICE_CODE_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    // No scope. A GitHub App's permissions are fixed when it is installed, and
    // asking for scopes here is an OAuth App concept that does not apply.
    body: JSON.stringify({ client_id: GITHUB_CLIENT_ID }),
    signal: AbortSignal.timeout(20_000)
  }, 'start the sign-in')

  const body = (await response.json().catch(() => ({}))) as Partial<DeviceCodeResponse> & { error?: string }

  if (!response.ok || !body.device_code || !body.user_code) {
    throw new GitHubAuthError(startupMessage(response.status, body.error), body.error)
  }

  return {
    code: {
      userCode: body.user_code,
      verificationUri: body.verification_uri ?? 'https://github.com/login/device',
      expiresIn: body.expires_in ?? 900
    },
    deviceCode: body.device_code,
    interval: body.interval ?? 5
  }
}

export interface PollOptions {
  deviceCode: string
  /** Seconds between attempts, as GitHub asked. */
  interval: number
  /** Give up after this many seconds. GitHub expires the code around 15 minutes. */
  expiresIn: number
  /** Called each time we are still waiting, so a UI can show it is alive. */
  onWaiting?: (secondsWaited: number) => void
  signal?: AbortSignal
}

/**
 * Poll until the user finishes, or the code dies.
 *
 * Returns the access token. Every GitHub error slug is translated into
 * something a person can act on — "authorization_pending" is not an error the
 * user should ever see, and "slow_down" is an instruction, not a failure.
 */
export async function pollForToken(options: PollOptions): Promise<string> {
  const started = Date.now()
  let interval = Math.max(options.interval, 1)

  while (Date.now() - started < options.expiresIn * 1000) {
    if (options.signal?.aborted) throw new GitHubAuthError('Sign-in cancelled.')
    await sleep(interval * 1000, options.signal)

    const response = await fetchOrExplain(ACCESS_TOKEN_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        device_code: options.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
      }),
      signal: AbortSignal.timeout(20_000)
    }, 'complete the sign-in')

    const body = (await response.json().catch(() => ({}))) as {
      access_token?: string
      error?: string
      interval?: number
    }

    if (body.access_token) return body.access_token

    switch (body.error) {
      case 'authorization_pending':
        options.onWaiting?.(Math.round((Date.now() - started) / 1000))
        break
      case 'slow_down':
        // An instruction, not a failure. GitHub sends a new interval with it.
        interval = body.interval ?? interval + 5
        options.onWaiting?.(Math.round((Date.now() - started) / 1000))
        break
      case 'expired_token':
        throw new GitHubAuthError('The code expired before it was entered. Start again.', body.error)
      case 'access_denied':
        throw new GitHubAuthError('Sign-in was declined on GitHub.', body.error)
      case 'incorrect_device_code':
        throw new GitHubAuthError('GitHub did not recognise this sign-in attempt. Start again.', body.error)
      default:
        if (body.error) throw new GitHubAuthError(`GitHub returned "${body.error}".`, body.error)
    }
  }

  throw new GitHubAuthError('The code expired before it was entered. Start again.', 'expired_token')
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new GitHubAuthError('Sign-in cancelled.'))
      },
      { once: true }
    )
  })
}
