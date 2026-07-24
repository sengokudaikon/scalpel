export {}

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      ELECTRON_RENDERER_URL?: string
      SCALPEL_DEBUG_LOG?: string
      SCALPEL_E2E?: string
      SCALPEL_E2E_USER_DATA?: string
      SCALPEL_POE_OAUTH_CLIENT_ID?: string
      SCALPEL_POE_OAUTH_REDIRECT_URIS?: string
      SCALPEL_POE_INSTANT_BUY_APPROVED?: string
      SCALPEL_POE_INSTANT_BUY_ACTION_URL?: string
    }
  }
}
