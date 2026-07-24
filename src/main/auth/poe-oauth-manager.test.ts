import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PoeOAuthConfig } from './poe-oauth-config'
import { generatePkce, PoeOAuthManager, type OAuthHttpResponse } from './poe-oauth-manager'
import { PoeTokenStorage, type TokenCipher } from './poe-token-storage'

const directories: string[] = []
const servers: ReturnType<typeof createServer>[] = []

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

async function config(): Promise<PoeOAuthConfig> {
  const ports = await Promise.all([freePort(), freePort(), freePort()])
  return {
    clientId: 'scalpel-test',
    redirectUris: ports.map((port) => `http://127.0.0.1:${port}/oauth/callback`) as [string, string, string],
    scopes: ['account:profile', 'account:trade', 'oauth:revoke'],
    userAgent: 'OAuth scalpel-test/1.0 (contact: test@example.invalid)',
    instantBuyTravelApproved: false,
  }
}

function cipher(secure = true): TokenCipher {
  return {
    isSecure: () => secure,
    encrypt: (value) => Buffer.from(value, 'utf8'),
    decrypt: (value) => value.toString('utf8'),
  }
}

async function manager(
  cfg: PoeOAuthConfig,
  options: {
    request?: (
      url: string,
      init: { method: string; headers: Record<string, string>; body?: string },
    ) => Promise<OAuthHttpResponse>
    openExternal?: (url: string) => Promise<void>
    secure?: boolean
    timeout?: number
    now?: () => number
  } = {},
): Promise<PoeOAuthManager> {
  const directory = await mkdtemp(join(tmpdir(), 'scalpel-oauth-manager-'))
  directories.push(directory)
  return new PoeOAuthManager(cfg, new PoeTokenStorage(join(directory, 'tokens'), cipher(options.secure)), {
    openExternal: options.openExternal ?? vi.fn().mockResolvedValue(undefined),
    request: options.request,
    authorizationTimeoutMs: options.timeout,
    now: options.now,
  })
}

function get(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    fetch(url)
      .then(() => resolve())
      .catch(reject)
  })
}

type RequestFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<OAuthHttpResponse>

function successfulRequest(): RequestFn {
  return vi.fn(async (url: string): Promise<OAuthHttpResponse> => {
    if (url.endsWith('/oauth/token')) {
      return {
        status: 200,
        text: JSON.stringify({
          access_token: 'access-secret',
          refresh_token: 'refresh-secret',
          expires_in: 36_000,
          token_type: 'bearer',
          scope: 'account:profile account:trade oauth:revoke',
          username: 'FromToken',
        }),
      }
    }
    return { status: 200, text: JSON.stringify({ name: 'VerifiedAccount' }) }
  })
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('PoeOAuthManager', () => {
  it('generates independent 32-byte PKCE verifier/state values and an S256 challenge', () => {
    const first = generatePkce()
    const second = generatePkce()
    expect(first.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(first.state).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(first.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(first.verifier).not.toBe(first.state)
    expect(first.verifier).not.toBe(second.verifier)
  })

  it('validates state, ignores noisy callbacks, and completes in the system browser', async () => {
    const cfg = await config()
    const request = successfulRequest()
    const auth = await manager(cfg, {
      request,
      openExternal: async (authorizationUrl) => {
        const authorization = new URL(authorizationUrl)
        const redirect = authorization.searchParams.get('redirect_uri')!
        await get(`${redirect}?state=wrong&code=attacker`)
        void get(`${redirect}?state=${authorization.searchParams.get('state')}&code=valid`)
      },
    })

    const snapshot = await auth.startAuthorization()

    expect(snapshot.status).toBe('authenticated')
    expect(snapshot.accountName).toBe('VerifiedAccount')
    expect(snapshot.persistence).toBe('encrypted')
    expect(snapshot.grantedScopes).not.toContain('access-secret')
    expect(vi.mocked(request)).toHaveBeenCalledTimes(2)
  })

  it('falls back to the next exact registered callback port', async () => {
    const cfg = await config()
    const occupied = createServer()
    servers.push(occupied)
    await new Promise<void>((resolve) =>
      occupied.listen(Number(new URL(cfg.redirectUris[0]).port), '127.0.0.1', resolve),
    )
    let chosen = ''
    const auth = await manager(cfg, {
      request: successfulRequest(),
      openExternal: async (authorizationUrl) => {
        const authorization = new URL(authorizationUrl)
        chosen = authorization.searchParams.get('redirect_uri')!
        void get(`${chosen}?state=${authorization.searchParams.get('state')}&code=valid`)
      },
    })

    expect((await auth.startAuthorization()).status).toBe('authenticated')
    expect(chosen).toBe(cfg.redirectUris[1])
  })

  it('handles denial, cancellation, timeout, and explicit insecure-keyring refusal', async () => {
    const deniedConfig = await config()
    const denied = await manager(deniedConfig, {
      openExternal: async (authorizationUrl) => {
        const authorization = new URL(authorizationUrl)
        const redirect = authorization.searchParams.get('redirect_uri')!
        void get(`${redirect}?state=${authorization.searchParams.get('state')}&error=access_denied`)
      },
    })
    expect((await denied.startAuthorization()).error?.reason).toBe('authorization-denied')

    const cancelConfig = await config()
    let opened!: () => void
    const openedPromise = new Promise<void>((resolve) => {
      opened = resolve
    })
    const cancelled = await manager(cancelConfig, { openExternal: async () => opened() })
    const pending = cancelled.startAuthorization()
    await openedPromise
    cancelled.cancelAuthorization()
    expect((await pending).error?.reason).toBe('authorization-cancelled')

    const timedOut = await manager(await config(), { timeout: 10 })
    expect((await timedOut.startAuthorization()).error?.reason).toBe('authorization-timeout')

    const insecure = await manager(await config(), { secure: false })
    const refused = await insecure.startAuthorization('encrypted')
    expect(refused.error?.reason).toBe('insecure-keyring')
    expect(refused.persistence).toBe('none')
  })

  it('allows explicit memory-only continuation without writing a token file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scalpel-oauth-memory-'))
    directories.push(directory)
    const tokenPath = join(directory, 'tokens')
    const cfg = await config()
    const auth = new PoeOAuthManager(cfg, new PoeTokenStorage(tokenPath, cipher(false)), {
      request: successfulRequest(),
      openExternal: async (authorizationUrl) => {
        const authorization = new URL(authorizationUrl)
        const redirect = authorization.searchParams.get('redirect_uri')!
        void get(`${redirect}?state=${authorization.searchParams.get('state')}&code=valid`)
      },
    })

    const snapshot = await auth.startAuthorization('memory-only')

    expect(snapshot.status).toBe('authenticated')
    expect(snapshot.persistence).toBe('memory-only')
    await expect(readFile(tokenPath)).rejects.toThrow()
  })

  it('rotates refresh tokens in a single flight without extending the seven-day expiry', async () => {
    let now = 1_000
    let refreshCalls = 0
    const request = vi.fn(async (url: string, init: { body?: string }): Promise<OAuthHttpResponse> => {
      if (url.endsWith('/profile')) return { status: 200, text: '{"name":"Account"}' }
      if (init.body?.includes('grant_type=refresh_token')) {
        refreshCalls++
        await new Promise((resolve) => setTimeout(resolve, 5))
        return {
          status: 200,
          text: JSON.stringify({
            access_token: 'rotated-access',
            refresh_token: 'rotated-refresh',
            expires_in: 36_000,
            token_type: 'bearer',
            scope: 'account:profile account:trade oauth:revoke',
          }),
        }
      }
      return {
        status: 200,
        text: JSON.stringify({
          access_token: 'initial-access',
          refresh_token: 'initial-refresh',
          expires_in: 1,
          token_type: 'bearer',
          scope: 'account:profile account:trade oauth:revoke',
        }),
      }
    })
    const cfg = await config()
    const auth = await manager(cfg, {
      now: () => now,
      request,
      openExternal: async (authorizationUrl) => {
        const authorization = new URL(authorizationUrl)
        const redirect = authorization.searchParams.get('redirect_uri')!
        void get(`${redirect}?state=${authorization.searchParams.get('state')}&code=valid`)
      },
    })
    const initial = await auth.startAuthorization()
    const originalRefreshExpiry = initial.refreshExpiresAt
    now += 2_000

    const tokens = await Promise.all([auth.getAccessToken(), auth.getAccessToken(), auth.getAccessToken()])

    expect(tokens).toEqual(['rotated-access', 'rotated-access', 'rotated-access'])
    expect(refreshCalls).toBe(1)
    expect(auth.getSnapshot().refreshExpiresAt).toBe(originalRefreshExpiry)
  })

  it('refreshes and retries one authenticated 401, then clears an invalid_grant', async () => {
    let resourceCalls = 0
    let invalidateRefresh = false
    const request = vi.fn(async (url: string, init: { body?: string }): Promise<OAuthHttpResponse> => {
      if (url.endsWith('/profile')) return { status: 200, text: '{"name":"Account"}' }
      if (url === 'https://api.example.invalid/resource') {
        resourceCalls++
        return resourceCalls === 1 ? { status: 401, text: '' } : { status: 200, text: '{"ok":true}' }
      }
      if (init.body?.includes('grant_type=refresh_token')) {
        if (invalidateRefresh) return { status: 400, text: '{"error":"invalid_grant"}' }
        return {
          status: 200,
          text: JSON.stringify({
            access_token: 'refreshed-access',
            refresh_token: 'refreshed-refresh',
            expires_in: 36_000,
            token_type: 'bearer',
            scope: 'account:profile account:trade oauth:revoke',
          }),
        }
      }
      return {
        status: 200,
        text: JSON.stringify({
          access_token: 'initial-access',
          refresh_token: 'initial-refresh',
          expires_in: 36_000,
          token_type: 'bearer',
          scope: 'account:profile account:trade oauth:revoke',
        }),
      }
    })
    const auth = await manager(await config(), {
      request,
      openExternal: async (authorizationUrl) => {
        const authorization = new URL(authorizationUrl)
        const redirect = authorization.searchParams.get('redirect_uri')!
        void get(`${redirect}?state=${authorization.searchParams.get('state')}&code=valid`)
      },
    })
    expect((await auth.startAuthorization()).loggedIn).toBe(true)

    expect((await auth.authorizedRequest('https://api.example.invalid/resource')).status).toBe(200)
    expect(resourceCalls).toBe(2)

    invalidateRefresh = true
    await expect(auth.getAccessToken(true)).rejects.toThrow()
    expect(auth.getSnapshot().loggedIn).toBe(false)
    expect(auth.getSnapshot().error?.reason).toBe('revoked')
  })

  it('attempts documented revocation and always clears local credentials', async () => {
    const request = successfulRequest()
    const auth = await manager(await config(), {
      request,
      openExternal: async (authorizationUrl) => {
        const authorization = new URL(authorizationUrl)
        const redirect = authorization.searchParams.get('redirect_uri')!
        void get(`${redirect}?state=${authorization.searchParams.get('state')}&code=valid`)
      },
    })
    await auth.startAuthorization()

    const snapshot = await auth.logout()

    expect(snapshot.status).toBe('logged-out')
    expect(snapshot.loggedIn).toBe(false)
    expect(
      vi
        .mocked(request)
        .mock.calls.some(
          ([url, init]) => url.endsWith('/oauth/token/revoke') && init.body?.includes('token_type_hint=refresh_token'),
        ),
    ).toBe(true)
  })

  it('rejects malformed token responses without exposing token material in the snapshot', async () => {
    const auth = await manager(await config(), {
      request: async () => ({
        status: 200,
        text: '{"access_token":"must-not-leak","expires_in":36000,"token_type":"bearer"}',
      }),
      openExternal: async (authorizationUrl) => {
        const authorization = new URL(authorizationUrl)
        const redirect = authorization.searchParams.get('redirect_uri')!
        void get(`${redirect}?state=${authorization.searchParams.get('state')}&code=valid`)
      },
    })

    const snapshot = await auth.startAuthorization()

    expect(snapshot.error?.reason).toBe('token-invalid')
    expect(JSON.stringify(snapshot)).not.toContain('must-not-leak')
  })
})
