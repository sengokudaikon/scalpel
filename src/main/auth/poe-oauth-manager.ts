import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { PoeAuthErrorReason, PoeAuthSnapshot, PoeAuthorizationPersistenceChoice } from '@shared/contracts/poe-auth'
import {
  POE_AUTHORIZE_URL,
  POE_PROFILE_URL,
  POE_REQUIRED_SCOPES,
  POE_REVOKE_URL,
  POE_TOKEN_URL,
  type PoeOAuthConfig,
  unavailableAuthSnapshot,
} from './poe-oauth-config'
import { type PoeTokenRecord, PoeTokenStorage } from './poe-token-storage'

const AUTHORIZATION_TIMEOUT_MS = 5 * 60 * 1000
const ACCESS_REFRESH_SKEW_MS = 60 * 1000
const PUBLIC_REFRESH_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000

export interface OAuthHttpResponse {
  status: number
  text: string
}

export interface PoeOAuthManagerDeps {
  now: () => number
  openExternal: (url: string) => Promise<void>
  request: (
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ) => Promise<OAuthHttpResponse>
  createServer: typeof createServer
  authorizationTimeoutMs?: number
}

const defaultRequest: PoeOAuthManagerDeps['request'] = async (url, init) => {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(15_000),
  })
  return { status: response.status, text: await response.text() }
}

export function base64Url(value: Buffer): string {
  return value.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export function generatePkce(): { verifier: string; challenge: string; state: string } {
  const verifier = base64Url(randomBytes(32))
  const challenge = base64Url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge, state: base64Url(randomBytes(32)) }
}

interface TokenEndpointBody {
  access_token?: unknown
  refresh_token?: unknown
  expires_in?: unknown
  token_type?: unknown
  scope?: unknown
  username?: unknown
  sub?: unknown
  error?: unknown
}

function parseScopes(value: unknown): string[] {
  return typeof value === 'string'
    ? [
        ...new Set(
          value
            .split(/\s+/)
            .map((scope) => scope.trim())
            .filter(Boolean),
        ),
      ]
    : []
}

function parseTokenResponse(text: string): TokenEndpointBody {
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? (parsed as TokenEndpointBody) : {}
  } catch {
    return {}
  }
}

function errorSnapshot(
  reason: PoeAuthErrorReason,
  message: string,
  retryable: boolean,
  persistence: PoeAuthSnapshot['persistence'] = 'none',
): PoeAuthSnapshot {
  return {
    status: 'error',
    loggedIn: false,
    persistence,
    grantedScopes: [],
    capabilities: { profile: false, authenticatedTrade: false, revoke: false, instantBuyTravel: false },
    error: { reason, message, retryable },
  }
}

export class PoeOAuthManager {
  private record: PoeTokenRecord | null = null
  private persistence: PoeAuthSnapshot['persistence'] = 'none'
  private snapshot: PoeAuthSnapshot
  private initialized = false
  private initializing: Promise<void> | null = null
  private refreshFlight: Promise<PoeTokenRecord> | null = null
  private activeAuthorization:
    | {
        server: Server
        finish: (snapshot: PoeAuthSnapshot) => void
      }
    | undefined
  private readonly listeners = new Set<(snapshot: PoeAuthSnapshot) => void>()
  private readonly deps: PoeOAuthManagerDeps

  constructor(
    private readonly config: PoeOAuthConfig | null,
    private readonly storage: PoeTokenStorage,
    deps: Partial<PoeOAuthManagerDeps> & Pick<PoeOAuthManagerDeps, 'openExternal'>,
  ) {
    this.snapshot = config ? this.loggedOutSnapshot() : unavailableAuthSnapshot()
    this.deps = {
      now: deps.now ?? Date.now,
      openExternal: deps.openExternal,
      request: deps.request ?? defaultRequest,
      createServer: deps.createServer ?? createServer,
      authorizationTimeoutMs: deps.authorizationTimeoutMs ?? AUTHORIZATION_TIMEOUT_MS,
    }
  }

  onChange(listener: (snapshot: PoeAuthSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot(): PoeAuthSnapshot {
    return structuredClone(this.snapshot)
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    if (this.initializing) return this.initializing
    this.initializing = this.initializeInternal().finally(() => {
      this.initialized = true
      this.initializing = null
    })
    return this.initializing
  }

  private async initializeInternal(): Promise<void> {
    if (!this.config) {
      this.update(unavailableAuthSnapshot())
      return
    }
    if (!this.storage.isSecure()) {
      this.update(this.loggedOutSnapshot('insecure-keyring', 'Secure keyring storage is unavailable on this system.'))
      return
    }
    const stored = await this.storage.load()
    if (!stored) return
    this.record = stored
    this.persistence = 'encrypted'
    if (!this.hasRequiredScopes(stored.scopes)) {
      await this.clearCredentials()
      this.update(this.loggedOutSnapshot('scope-missing', 'The saved authorization no longer grants required scopes.'))
      return
    }
    if (stored.refreshExpiresAt <= this.deps.now()) {
      await this.clearCredentials()
      this.update(this.expiredSnapshot('refresh-expired', 'The seven-day refresh authorization has expired.'))
      return
    }
    this.update(this.authenticatedSnapshot())
    if (stored.accessExpiresAt <= this.deps.now() + ACCESS_REFRESH_SKEW_MS) {
      try {
        await this.refresh()
      } catch {
        // A transient failure must not erase a still-refreshable authorization.
      }
    }
  }

  async startAuthorization(choice: PoeAuthorizationPersistenceChoice = 'encrypted'): Promise<PoeAuthSnapshot> {
    await this.initialize()
    if (!this.config) return this.getSnapshot()
    if (this.activeAuthorization) return this.getSnapshot()
    if (this.record) return this.getSnapshot()
    if (choice === 'encrypted' && !this.storage.isSecure()) {
      const snapshot = this.loggedOutSnapshot(
        'insecure-keyring',
        'Install or unlock a system keyring, or explicitly continue memory-only for this process.',
      )
      this.update(snapshot)
      return snapshot
    }

    const pkce = generatePkce()
    const binding = await this.bindFirstRedirect(pkce.state, pkce.verifier, choice)
    if (!binding) {
      const snapshot = errorSnapshot(
        'callback-unavailable',
        'None of the three registered OAuth callback ports could be opened.',
        true,
      )
      this.update(snapshot)
      return snapshot
    }

    const { redirectUri, completion } = binding
    this.update({
      ...this.loggedOutSnapshot(),
      status: 'authorizing',
      persistence: choice === 'memory-only' ? 'memory-only' : 'encrypted',
    })
    const url = new URL(POE_AUTHORIZE_URL)
    url.searchParams.set('client_id', this.config.clientId)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', this.config.scopes.join(' '))
    url.searchParams.set('state', pkce.state)
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('code_challenge', pkce.challenge)
    url.searchParams.set('code_challenge_method', 'S256')

    try {
      await this.deps.openExternal(url.toString())
    } catch {
      const active = this.activeAuthorization as
        | { server: Server; finish: (snapshot: PoeAuthSnapshot) => void }
        | undefined
      active?.finish(errorSnapshot('network', 'The system browser could not be opened for authorization.', true))
    }
    return completion
  }

  cancelAuthorization(): PoeAuthSnapshot {
    this.activeAuthorization?.finish(
      this.loggedOutSnapshot('authorization-cancelled', 'Browser authorization was cancelled.'),
    )
    return this.getSnapshot()
  }

  async logout(): Promise<PoeAuthSnapshot> {
    await this.initialize()
    this.cancelAuthorization()
    try {
      await this.getAccessToken()
    } catch {
      // Revocation remains best-effort; local cleanup is unconditional.
    }
    const record = this.record
    if (record && record.scopes.includes('oauth:revoke') && this.config) {
      try {
        const body = new URLSearchParams({
          token: record.refreshToken,
          token_type_hint: 'refresh_token',
        }).toString()
        await this.deps.request(POE_REVOKE_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
            Authorization: `Bearer ${record.accessToken}`,
            'User-Agent': this.config.userAgent,
          },
          body,
        })
      } catch {
        // Logout always clears local credentials, even when remote revocation is unavailable.
      }
    }
    await this.clearCredentials()
    this.update(this.config ? this.loggedOutSnapshot() : unavailableAuthSnapshot())
    return this.getSnapshot()
  }

  async getAccessToken(forceRefresh = false): Promise<string | null> {
    await this.initialize()
    if (!this.record) return null
    if (this.record.refreshExpiresAt <= this.deps.now()) {
      await this.clearCredentials()
      this.update(this.expiredSnapshot('refresh-expired', 'The seven-day refresh authorization has expired.'))
      return null
    }
    if (forceRefresh || this.record.accessExpiresAt <= this.deps.now() + ACCESS_REFRESH_SKEW_MS) {
      return (await this.refresh()).accessToken
    }
    return this.record.accessToken
  }

  async authorizedRequest(
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string } = {},
  ): Promise<OAuthHttpResponse> {
    const requestOnce = async (forceRefresh: boolean): Promise<OAuthHttpResponse> => {
      const token = await this.getAccessToken(forceRefresh)
      if (!token || !this.config) return { status: 401, text: '' }
      return this.deps.request(url, {
        method: init.method ?? 'GET',
        headers: {
          Accept: 'application/json',
          'User-Agent': this.config.userAgent,
          ...init.headers,
          Authorization: `Bearer ${token}`,
        },
        body: init.body,
      })
    }
    let response = await requestOnce(false)
    if (response.status === 401) response = await requestOnce(true)
    if (response.status === 403) {
      await this.clearCredentials()
      this.update(this.loggedOutSnapshot('scope-missing', 'Path of Exile rejected the required authorization scope.'))
    }
    return response
  }

  private async bindFirstRedirect(
    expectedState: string,
    verifier: string,
    choice: PoeAuthorizationPersistenceChoice,
  ): Promise<{ server: Server; redirectUri: string; completion: Promise<PoeAuthSnapshot> } | null> {
    if (!this.config) return null
    for (const redirectUri of this.config.redirectUris) {
      const redirect = new URL(redirectUri)
      let resolveCompletion!: (snapshot: PoeAuthSnapshot) => void
      const completion = new Promise<PoeAuthSnapshot>((resolve) => {
        resolveCompletion = resolve
      })
      let terminal = false
      let timeout: ReturnType<typeof setTimeout> | undefined
      const server = this.deps.createServer((request, response) => {
        const incoming = new URL(request.url ?? '/', `http://127.0.0.1:${redirect.port}`)
        if (request.method !== 'GET' || incoming.pathname !== redirect.pathname) {
          response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          response.end('Not found')
          return
        }
        if (incoming.searchParams.get('state') !== expectedState) {
          response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
          response.end('Invalid OAuth state. You may close this tab.')
          return
        }
        const error = incoming.searchParams.get('error')
        if (error) {
          response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          response.end('<p>Authorization was not granted. You may close this tab.</p>')
          finish(this.loggedOutSnapshot('authorization-denied', 'Path of Exile authorization was denied.'))
          return
        }
        const code = incoming.searchParams.get('code')
        if (!code) {
          response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
          response.end('Missing authorization code.')
          return
        }
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        response.end('<p>Scalpel authorization completed. You may close this tab.</p>')
        void this.completeAuthorization(code, verifier, redirectUri, choice).then(async (snapshot) => {
          if (terminal) {
            // Cancellation may race the HTTPS exchange. Never retain credentials
            // produced after the user cancelled the attempt.
            if (snapshot.loggedIn) await this.clearCredentials()
            return
          }
          finish(snapshot)
        })
      })
      const finish = (snapshot: PoeAuthSnapshot): void => {
        if (terminal) return
        terminal = true
        if (timeout) clearTimeout(timeout)
        server.close()
        if (this.activeAuthorization?.server === server) this.activeAuthorization = undefined
        this.update(snapshot)
        resolveCompletion(this.getSnapshot())
      }
      const listening = await new Promise<boolean>((resolve) => {
        const onError = (): void => resolve(false)
        server.once('error', onError)
        server.listen(Number(redirect.port), '127.0.0.1', () => {
          server.removeListener('error', onError)
          resolve(true)
        })
      })
      if (!listening) {
        server.close()
        continue
      }
      const address = server.address() as AddressInfo | null
      if (!address || address.address !== '127.0.0.1' || address.port !== Number(redirect.port)) {
        server.close()
        continue
      }
      server.on('error', () => {
        finish(errorSnapshot('callback-unavailable', 'The OAuth callback listener stopped unexpectedly.', true))
      })
      timeout = setTimeout(
        () => finish(this.loggedOutSnapshot('authorization-timeout', 'Browser authorization timed out.')),
        this.deps.authorizationTimeoutMs,
      )
      this.activeAuthorization = { server, finish }
      return { server, redirectUri, completion }
    }
    return null
  }

  private async completeAuthorization(
    code: string,
    verifier: string,
    redirectUri: string,
    choice: PoeAuthorizationPersistenceChoice,
  ): Promise<PoeAuthSnapshot> {
    if (!this.config) return unavailableAuthSnapshot()
    try {
      const body = new URLSearchParams({
        client_id: this.config.clientId,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        scope: this.config.scopes.join(' '),
        code_verifier: verifier,
      }).toString()
      const response = await this.deps.request(POE_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          'User-Agent': this.config.userAgent,
        },
        body,
      })
      if (response.status < 200 || response.status >= 300) {
        const parsed = parseTokenResponse(response.text)
        return errorSnapshot(
          parsed.error === 'access_denied' ? 'authorization-denied' : 'token-invalid',
          'Path of Exile did not issue a valid authorization.',
          response.status >= 500,
        )
      }
      const parsed = parseTokenResponse(response.text)
      const record = this.recordFromTokenResponse(parsed)
      if (!record) return errorSnapshot('token-invalid', 'Path of Exile returned an invalid token response.', false)
      if (!this.hasRequiredScopes(record.scopes)) {
        return errorSnapshot('scope-missing', 'The authorization did not grant all required scopes.', false)
      }
      this.record = record
      this.persistence = choice === 'memory-only' ? 'memory-only' : 'encrypted'

      const profile = await this.authorizedRequest(POE_PROFILE_URL)
      if (profile.status !== 200) {
        await this.clearCredentials()
        return errorSnapshot('profile-invalid', 'The authorized Path of Exile profile could not be verified.', true)
      }
      const parsedProfile = JSON.parse(profile.text) as { name?: unknown }
      if (typeof parsedProfile.name !== 'string' || !parsedProfile.name) {
        await this.clearCredentials()
        return errorSnapshot('profile-invalid', 'The Path of Exile profile response had no account name.', false)
      }
      // authorizedRequest may have refreshed a near-expiry access token while
      // fetching the profile. Preserve that rotated record instead of putting
      // the original token back.
      const activeRecord = this.record ?? record
      activeRecord.accountName = parsedProfile.name
      this.record = activeRecord
      if (choice === 'encrypted') {
        try {
          await this.storage.save(activeRecord)
        } catch {
          await this.storage.clear()
          this.persistence = 'memory-only'
          return this.authenticatedSnapshot({
            reason: 'storage-failed',
            message: 'Authorization is active for this process but could not be saved securely.',
            retryable: true,
          })
        }
      }
      return this.authenticatedSnapshot()
    } catch {
      if (this.record) await this.clearCredentials()
      return errorSnapshot('network', 'Authorization could not be completed because of a network error.', true)
    }
  }

  private recordFromTokenResponse(parsed: TokenEndpointBody, refreshExpiresAt?: number): PoeTokenRecord | null {
    if (
      typeof parsed.access_token !== 'string' ||
      !parsed.access_token ||
      typeof parsed.refresh_token !== 'string' ||
      !parsed.refresh_token ||
      typeof parsed.expires_in !== 'number' ||
      !Number.isFinite(parsed.expires_in) ||
      parsed.expires_in <= 0 ||
      typeof parsed.token_type !== 'string' ||
      parsed.token_type.toLowerCase() !== 'bearer'
    ) {
      return null
    }
    const now = this.deps.now()
    return {
      accessToken: parsed.access_token,
      refreshToken: parsed.refresh_token,
      tokenType: 'bearer',
      scopes: parseScopes(parsed.scope),
      accountName: typeof parsed.username === 'string' ? parsed.username : '',
      subject: typeof parsed.sub === 'string' ? parsed.sub : undefined,
      accessExpiresAt: now + parsed.expires_in * 1000,
      refreshExpiresAt: refreshExpiresAt ?? now + PUBLIC_REFRESH_LIFETIME_MS,
    }
  }

  private async refresh(): Promise<PoeTokenRecord> {
    if (this.refreshFlight) return this.refreshFlight
    this.refreshFlight = this.refreshInternal().finally(() => {
      this.refreshFlight = null
    })
    return this.refreshFlight
  }

  private async refreshInternal(): Promise<PoeTokenRecord> {
    const current = this.record
    if (!current || !this.config) throw new Error('Not authorized')
    if (current.refreshExpiresAt <= this.deps.now()) {
      await this.clearCredentials()
      this.update(this.expiredSnapshot('refresh-expired', 'The seven-day refresh authorization has expired.'))
      throw new Error('Refresh expired')
    }
    try {
      const body = new URLSearchParams({
        client_id: this.config.clientId,
        grant_type: 'refresh_token',
        refresh_token: current.refreshToken,
      }).toString()
      const response = await this.deps.request(POE_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          'User-Agent': this.config.userAgent,
        },
        body,
      })
      const parsed = parseTokenResponse(response.text)
      if (response.status < 200 || response.status >= 300) {
        if (parsed.error === 'invalid_grant') {
          await this.clearCredentials()
          this.update(this.loggedOutSnapshot('revoked', 'The Path of Exile authorization was revoked or expired.'))
        }
        throw new Error('Refresh failed')
      }
      const next = this.recordFromTokenResponse(parsed, current.refreshExpiresAt)
      if (!next) {
        await this.clearCredentials()
        this.update(this.loggedOutSnapshot('token-invalid', 'Path of Exile returned an invalid refresh response.'))
        throw new Error('Invalid refresh response')
      }
      if (!this.hasRequiredScopes(next.scopes)) {
        await this.clearCredentials()
        this.update(this.loggedOutSnapshot('scope-missing', 'The refreshed authorization lost a required scope.'))
        throw new Error('Invalid refresh response')
      }
      next.accountName = current.accountName || next.accountName
      this.record = next
      if (this.persistence === 'encrypted') {
        try {
          await this.storage.save(next)
        } catch {
          await this.storage.clear()
          this.persistence = 'memory-only'
          this.update(
            this.authenticatedSnapshot({
              reason: 'storage-failed',
              message: 'The rotated authorization is active memory-only but could not be saved securely.',
              retryable: true,
            }),
          )
          return next
        }
      }
      this.update(this.authenticatedSnapshot())
      return next
    } catch (error) {
      if (this.record) {
        this.update(
          this.authenticatedSnapshot({
            reason: 'network',
            message: 'Path of Exile authorization could not be refreshed yet.',
            retryable: true,
          }),
        )
      }
      throw error
    }
  }

  private hasRequiredScopes(scopes: string[]): boolean {
    return POE_REQUIRED_SCOPES.every((scope) => scopes.includes(scope))
  }

  private authenticatedSnapshot(error?: PoeAuthSnapshot['error']): PoeAuthSnapshot {
    const record = this.record
    if (!record || !this.config) return this.loggedOutSnapshot()
    return {
      status: 'authenticated',
      loggedIn: true,
      accountName: record.accountName,
      accessExpiresAt: record.accessExpiresAt,
      refreshExpiresAt: record.refreshExpiresAt,
      persistence: this.persistence,
      grantedScopes: [...record.scopes],
      capabilities: {
        profile: record.scopes.includes('account:profile'),
        authenticatedTrade: record.scopes.includes('account:trade'),
        revoke: record.scopes.includes('oauth:revoke'),
        instantBuyTravel: this.config.instantBuyTravelApproved && record.scopes.includes('account:trade'),
      },
      error,
    }
  }

  private loggedOutSnapshot(reason?: PoeAuthErrorReason, message?: string): PoeAuthSnapshot {
    return {
      status: 'logged-out',
      loggedIn: false,
      persistence: 'none',
      grantedScopes: [],
      capabilities: { profile: false, authenticatedTrade: false, revoke: false, instantBuyTravel: false },
      ...(reason && message ? { error: { reason, message, retryable: reason !== 'oauth-unavailable' } } : {}),
    }
  }

  private expiredSnapshot(reason: PoeAuthErrorReason, message: string): PoeAuthSnapshot {
    return { ...this.loggedOutSnapshot(reason, message), status: 'expired' }
  }

  private async clearCredentials(): Promise<void> {
    this.record = null
    this.persistence = 'none'
    await this.storage.clear()
  }

  private update(snapshot: PoeAuthSnapshot): void {
    this.snapshot = snapshot
    for (const listener of this.listeners) listener(this.getSnapshot())
  }
}
