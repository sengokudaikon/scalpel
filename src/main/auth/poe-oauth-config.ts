import type { PoeAuthSnapshot } from '@shared/contracts/poe-auth'

export const POE_AUTHORIZE_URL = 'https://www.pathofexile.com/oauth/authorize'
export const POE_TOKEN_URL = 'https://www.pathofexile.com/oauth/token'
export const POE_REVOKE_URL = 'https://www.pathofexile.com/oauth/token/revoke'
export const POE_PROFILE_URL = 'https://api.pathofexile.com/profile'

export const POE_OAUTH_SCOPES = ['account:profile', 'account:trade', 'oauth:revoke'] as const
export const POE_REQUIRED_SCOPES = ['account:profile', 'account:trade'] as const

export interface PoeOAuthConfig {
  clientId: string
  redirectUris: [string, string, string]
  scopes: string[]
  userAgent: string
  instantBuyTravelApproved: boolean
  instantBuyTravelEndpoint?: string
}

function validLoopbackRedirect(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      url.protocol === 'http:' &&
      url.hostname === '127.0.0.1' &&
      url.port !== '' &&
      url.pathname !== '/' &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === ''
    )
  } catch {
    return false
  }
}

/** OAuth registration is deployment configuration, never borrowed from another app. */
export function loadPoeOAuthConfig(env: NodeJS.ProcessEnv = process.env): PoeOAuthConfig | null {
  const clientId = env.SCALPEL_POE_OAUTH_CLIENT_ID?.trim()
  const redirects = (env.SCALPEL_POE_OAUTH_REDIRECT_URIS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)

  if (
    !clientId ||
    redirects.length !== 3 ||
    new Set(redirects).size !== 3 ||
    redirects.some((value) => !validLoopbackRedirect(value))
  ) {
    return null
  }

  const merchantEndpoint = env.SCALPEL_POE_INSTANT_BUY_ACTION_URL?.trim()
  const validMerchantEndpoint = (() => {
    if (!merchantEndpoint) return undefined
    try {
      const url = new URL(merchantEndpoint)
      return url.protocol === 'https:' ? url.toString() : undefined
    } catch {
      return undefined
    }
  })()

  return {
    clientId,
    redirectUris: redirects as [string, string, string],
    scopes: [...POE_OAUTH_SCOPES],
    userAgent: `OAuth ${clientId}/${env.npm_package_version ?? '1.0.0'} (contact: https://github.com/scalpelpoe/scalpel)`,
    // This switch represents written GGG approval. There is intentionally no
    // undocumented endpoint in the application.
    instantBuyTravelApproved: env.SCALPEL_POE_INSTANT_BUY_APPROVED === 'true' && validMerchantEndpoint !== undefined,
    instantBuyTravelEndpoint: validMerchantEndpoint,
  }
}

export function unavailableAuthSnapshot(): PoeAuthSnapshot {
  return {
    status: 'unavailable',
    loggedIn: false,
    persistence: 'none',
    grantedScopes: [],
    capabilities: {
      profile: false,
      authenticatedTrade: false,
      revoke: false,
      instantBuyTravel: false,
    },
    error: {
      reason: 'oauth-unavailable',
      message: 'Scalpel OAuth is not configured with its own approved Path of Exile public client.',
      retryable: false,
    },
  }
}
