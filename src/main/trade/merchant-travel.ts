import type { TradeActionResult } from '@shared/contracts/trade-actions'
import type { PoeOAuthManager } from '../auth/poe-oauth-manager'
import type { RegisteredListingAction } from './listing-action-registry'

export interface MerchantTravelProvider {
  readonly kind: 'approved-api' | 'external-browser'
  isAvailable(): boolean
  travel(listing: RegisteredListingAction, exactSearchUrl: string): Promise<TradeActionResult>
}

export class ExternalBrowserMerchantTravelProvider implements MerchantTravelProvider {
  readonly kind = 'external-browser' as const

  constructor(private readonly openExternal: (url: string) => Promise<void>) {}

  isAvailable(): boolean {
    return true
  }

  async travel(_listing: RegisteredListingAction, exactSearchUrl: string): Promise<TradeActionResult> {
    try {
      await this.openExternal(exactSearchUrl)
      return { ok: true, action: 'instant-buy', mode: 'external-browser' }
    } catch {
      return {
        ok: false,
        action: 'instant-buy',
        reason: 'browser-open-failed',
        message: 'The instant-buy search could not be opened in the system browser.',
        retryable: true,
      }
    }
  }
}

export class ApprovedApiMerchantTravelProvider implements MerchantTravelProvider {
  readonly kind = 'approved-api' as const
  private nextAllowedAt = 0

  constructor(
    private readonly endpoint: string | undefined,
    private readonly explicitlyApproved: boolean,
    private readonly auth: PoeOAuthManager,
  ) {}

  isAvailable(): boolean {
    return this.explicitlyApproved && this.endpoint !== undefined
  }

  async travel(listing: RegisteredListingAction): Promise<TradeActionResult> {
    if (!this.isAvailable() || !listing.merchantToken) {
      return {
        ok: false,
        action: 'instant-buy',
        reason: 'approval-unavailable',
        message: 'GGG-approved instant-buy travel is unavailable for this listing.',
        retryable: false,
      }
    }
    const wait = Math.max(0, this.nextAllowedAt - Date.now())
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    this.nextAllowedAt = Date.now() + 1000
    try {
      const response = await this.auth.authorizedRequest(this.endpoint!, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: listing.merchantToken }),
      })
      if (response.status >= 200 && response.status < 300) {
        return { ok: true, action: 'instant-buy', mode: 'approved-api' }
      }
      return {
        ok: false,
        action: 'instant-buy',
        reason: response.status === 401 ? 'unauthorized' : 'network',
        message: 'Path of Exile did not accept the instant-buy travel request.',
        retryable: response.status >= 500 || response.status === 401,
      }
    } catch {
      return {
        ok: false,
        action: 'instant-buy',
        reason: 'network',
        message: 'The instant-buy travel request failed.',
        retryable: true,
      }
    }
  }
}

/** Selects the approved provider only when it is both explicitly enabled and usable. */
export function selectMerchantTravelProvider(
  approved: MerchantTravelProvider | null,
  fallback: MerchantTravelProvider,
): MerchantTravelProvider {
  return approved?.kind === 'approved-api' && approved.isAvailable() ? approved : fallback
}
