export type TradeActionErrorReason =
  | 'listing-not-found'
  | 'listing-expired'
  | 'missing-whisper'
  | 'missing-character'
  | 'wrong-listing-kind'
  | 'game-not-found'
  | 'action-in-progress'
  | 'approval-unavailable'
  | 'browser-open-failed'
  | 'network'
  | 'unauthorized'
  | 'unknown'

export type TradeActionResult =
  | {
      ok: true
      action: 'whisper' | 'hideout' | 'instant-buy'
      mode: 'game-chat' | 'approved-api' | 'external-browser'
    }
  | {
      ok: false
      action: 'whisper' | 'hideout' | 'instant-buy'
      reason: TradeActionErrorReason
      message: string
      retryable: boolean
    }

export interface ListingActionRef {
  queryId: string
  listingId: string
}
