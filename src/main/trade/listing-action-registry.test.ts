import { describe, expect, it, vi } from 'vitest'
import { ListingActionRegistry } from './listing-action-registry'
import {
  ExternalBrowserMerchantTravelProvider,
  selectMerchantTravelProvider,
  type MerchantTravelProvider,
} from './merchant-travel'

describe('ListingActionRegistry', () => {
  it('only resolves data registered from a fetched query and expires it', () => {
    let now = 1_000
    const registry = new ListingActionRegistry(() => now)
    registry.register('query', 'Standard', 2, [
      {
        id: 'listing',
        whisper: '@Seller localized whisper text',
        characterName: 'Seller',
        instantBuyout: false,
      },
    ])
    expect(registry.get('query', 'listing')?.whisper).toBe('@Seller localized whisper text')
    expect(registry.get('forged', 'listing')).toBeNull()
    now += 16 * 60 * 1000
    expect(registry.get('query', 'listing')).toBeNull()
  })

  it('selects approved API only when explicitly available, otherwise opens the exact browser query', async () => {
    const approved: MerchantTravelProvider = {
      kind: 'approved-api',
      isAvailable: () => false,
      travel: vi.fn(),
    }
    const openExternal = vi.fn().mockResolvedValue(undefined)
    const fallback = new ExternalBrowserMerchantTravelProvider(openExternal)
    const selected = selectMerchantTravelProvider(approved, fallback)
    const listing = {
      queryId: 'opaque-query',
      listingId: 'listing',
      league: 'Test League',
      version: 2 as const,
      instantBuyout: true,
    }

    expect(selected.kind).toBe('external-browser')
    expect(await selected.travel(listing, 'https://example.invalid/exact-query')).toEqual({
      ok: true,
      action: 'instant-buy',
      mode: 'external-browser',
    })
    expect(openExternal).toHaveBeenCalledWith('https://example.invalid/exact-query')
  })
})
