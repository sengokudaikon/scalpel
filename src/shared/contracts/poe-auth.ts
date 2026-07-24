export type PoeAuthStatus = 'unavailable' | 'logged-out' | 'authorizing' | 'authenticated' | 'expired' | 'error'

export type PoeAuthPersistence = 'none' | 'encrypted' | 'memory-only'

export type PoeAuthErrorReason =
  | 'oauth-unavailable'
  | 'authorization-cancelled'
  | 'authorization-denied'
  | 'authorization-timeout'
  | 'callback-unavailable'
  | 'state-mismatch'
  | 'token-invalid'
  | 'profile-invalid'
  | 'scope-missing'
  | 'refresh-expired'
  | 'revoked'
  | 'insecure-keyring'
  | 'storage-failed'
  | 'network'
  | 'unknown'

/** Renderer-safe authentication state. Tokens never cross IPC. */
export interface PoeAuthSnapshot {
  status: PoeAuthStatus
  loggedIn: boolean
  accountName?: string
  accessExpiresAt?: number
  refreshExpiresAt?: number
  persistence: PoeAuthPersistence
  grantedScopes: string[]
  capabilities: {
    profile: boolean
    authenticatedTrade: boolean
    revoke: boolean
    instantBuyTravel: boolean
  }
  error?: {
    reason: PoeAuthErrorReason
    message: string
    retryable: boolean
  }
}

export type PoeAuthorizationPersistenceChoice = 'encrypted' | 'memory-only'
