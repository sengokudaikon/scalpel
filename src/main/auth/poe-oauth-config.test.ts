import { describe, expect, it } from 'vitest'
import { loadPoeOAuthConfig } from './poe-oauth-config'

describe('loadPoeOAuthConfig', () => {
  it('requires a Scalpel client and exactly three unique 127.0.0.1 redirects', () => {
    expect(loadPoeOAuthConfig({})).toBeNull()
    expect(
      loadPoeOAuthConfig({
        SCALPEL_POE_OAUTH_CLIENT_ID: 'scalpel',
        SCALPEL_POE_OAUTH_REDIRECT_URIS:
          'http://localhost:1/callback,http://127.0.0.1:2/callback,http://127.0.0.1:3/callback',
      }),
    ).toBeNull()
    expect(
      loadPoeOAuthConfig({
        SCALPEL_POE_OAUTH_CLIENT_ID: 'scalpel',
        SCALPEL_POE_OAUTH_REDIRECT_URIS:
          'http://127.0.0.1:1/callback,http://127.0.0.1:2/callback,http://127.0.0.1:3/callback',
      })?.redirectUris,
    ).toHaveLength(3)
  })

  it('does not enable instant-buy API travel without both approval and an HTTPS endpoint', () => {
    const base = {
      SCALPEL_POE_OAUTH_CLIENT_ID: 'scalpel',
      SCALPEL_POE_OAUTH_REDIRECT_URIS:
        'http://127.0.0.1:1/callback,http://127.0.0.1:2/callback,http://127.0.0.1:3/callback',
      SCALPEL_POE_INSTANT_BUY_APPROVED: 'true',
    }
    expect(loadPoeOAuthConfig(base)?.instantBuyTravelApproved).toBe(false)
    expect(
      loadPoeOAuthConfig({
        ...base,
        SCALPEL_POE_INSTANT_BUY_ACTION_URL: 'https://api.example.invalid/approved-action',
      })?.instantBuyTravelApproved,
    ).toBe(true)
  })
})
