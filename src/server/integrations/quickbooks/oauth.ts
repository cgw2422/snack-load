import { randomBytes } from 'node:crypto'
import { env } from '@/lib/env'
import { OAUTH, SCOPES, type TokenSet } from './types'

/**
 * The OAuth 2.0 round trip (docs/08 §3).
 *
 * Verified against Intuit's current behaviour, September 2026:
 *
 *  - Authorization is a browser redirect to `appcenter.intuit.com`, and the
 *    callback carries `code`, `state` and **`realmId`** — the company id is
 *    part of the grant, not something we ask for afterwards.
 *  - Access tokens last one hour.
 *  - **Refresh tokens rotate.** Every refresh returns a new one and the old one
 *    stops working; Intuit's November 2025 policy note puts the rotation
 *    interval at roughly a day and the outer lifetime at up to five years. The
 *    consequence for us is not the number, it is that the new token must be
 *    persisted on every single refresh or the connection dies at the next one.
 *  - Token and revoke calls authenticate with HTTP Basic using the app's client
 *    id and secret, and take form-encoded bodies.
 *
 * Nothing here touches the database. `integration.service.ts` owns persistence,
 * including the transaction that makes the rotation atomic.
 */

export type OAuthConfig = {
  clientId: string
  clientSecret: string
  redirectUri: string
}

/** Null when the app has not been given Intuit credentials. */
export function oauthConfig(): OAuthConfig | null {
  const { QUICKBOOKS_CLIENT_ID, QUICKBOOKS_CLIENT_SECRET, APP_URL } = env()
  if (!QUICKBOOKS_CLIENT_ID || !QUICKBOOKS_CLIENT_SECRET) return null
  return {
    clientId: QUICKBOOKS_CLIENT_ID,
    clientSecret: QUICKBOOKS_CLIENT_SECRET,
    redirectUri: `${APP_URL.replace(/\/$/, '')}/api/integrations/quickbooks/callback`,
  }
}

/**
 * 32 bytes of CSPRNG, the same standard as a share-link token. It is stored on
 * the connection and compared on the callback, so a forged callback cannot
 * attach somebody else's QuickBooks company to this organization.
 */
export function newOAuthState(): string {
  return randomBytes(32).toString('base64url')
}

export function authorizeUrl(config: OAuthConfig, state: string): string {
  const url = new URL(OAUTH.authorize)
  url.searchParams.set('client_id', config.clientId)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', SCOPES.join(' '))
  url.searchParams.set('redirect_uri', config.redirectUri)
  url.searchParams.set('state', state)
  return url.toString()
}

function basicAuth(config: OAuthConfig): string {
  return `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`
}

async function tokenCall(config: OAuthConfig, body: URLSearchParams): Promise<TokenSet> {
  const response = await fetch(OAUTH.token, {
    method: 'POST',
    headers: {
      Authorization: basicAuth(config),
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
  })

  const text = await response.text()
  if (!response.ok) {
    // Intuit returns `invalid_grant` for a refresh token that has already
    // rotated or been revoked. The caller turns that into NEEDS_REAUTH; it is
    // not something a retry will fix.
    throw new OAuthError(response.status, text)
  }

  const json = JSON.parse(text) as {
    access_token: string
    refresh_token: string
    expires_in: number
    x_refresh_token_expires_in: number
    scope?: string
    realmId?: string
  }

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresIn: json.expires_in,
    refreshExpiresIn: json.x_refresh_token_expires_in,
    scope: json.scope ?? SCOPES.join(' '),
    realmId: json.realmId,
  }
}

export class OAuthError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly body: string,
  ) {
    // The body can echo a token on some error paths, so it is summarised rather
    // than interpolated. `body` stays available to the caller, which decides
    // what is safe to store.
    super(`QuickBooks rejected the token request (HTTP ${httpStatus}).`)
    this.name = 'OAuthError'
  }

  /** A grant that will never work again, however many times we ask. */
  get permanent(): boolean {
    if (this.httpStatus === 400 || this.httpStatus === 401) return true
    return /invalid_grant|invalid_client|unauthorized/i.test(this.body)
  }
}

export function exchangeCode(config: OAuthConfig, code: string): Promise<TokenSet> {
  return tokenCall(
    config,
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.redirectUri,
    }),
  )
}

export function refreshTokens(config: OAuthConfig, refreshToken: string): Promise<TokenSet> {
  return tokenCall(
    config,
    new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  )
}

/**
 * Revoking on disconnect. Best effort by design: if Intuit is unreachable we
 * still drop our copy of the tokens, because leaving a usable secret in our
 * database is the worse of the two failures.
 */
export async function revokeToken(config: OAuthConfig, token: string): Promise<boolean> {
  try {
    const response = await fetch(OAUTH.revoke, {
      method: 'POST',
      headers: {
        Authorization: basicAuth(config),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ token }),
    })
    return response.ok
  } catch {
    return false
  }
}
