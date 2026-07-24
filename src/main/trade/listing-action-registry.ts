import { getTradeUrls } from '@shared/endpoints'

const LISTING_TTL_MS = 15 * 60 * 1000
const MAX_QUERIES = 100

export interface RegisteredListingAction {
  queryId: string
  listingId: string
  league: string
  version: 1 | 2
  whisper?: string
  characterName?: string
  instantBuyout: boolean
  /** Only an opaque value explicitly returned by a documented/approved API. */
  merchantToken?: string
}

interface QueryEntry {
  createdAt: number
  listings: Map<string, RegisteredListingAction>
}

export class ListingActionRegistry {
  private readonly queries = new Map<string, QueryEntry>()

  constructor(private readonly now: () => number = Date.now) {}

  register(
    queryId: string,
    league: string,
    version: 1 | 2,
    listings: Array<{
      id: string
      whisper?: string
      characterName?: string
      instantBuyout: boolean
      merchantToken?: string
    }>,
  ): void {
    if (!queryId) return
    this.prune()
    const existing = this.queries.get(queryId)
    const entry: QueryEntry = existing ?? { createdAt: this.now(), listings: new Map() }
    for (const listing of listings) {
      entry.listings.set(listing.id, {
        queryId,
        listingId: listing.id,
        league,
        version,
        whisper: listing.whisper,
        characterName: listing.characterName,
        instantBuyout: listing.instantBuyout,
        merchantToken: listing.merchantToken,
      })
    }
    this.queries.delete(queryId)
    this.queries.set(queryId, entry)
    while (this.queries.size > MAX_QUERIES) {
      const oldest = this.queries.keys().next().value as string | undefined
      if (!oldest) break
      this.queries.delete(oldest)
    }
  }

  get(queryId: string, listingId: string): RegisteredListingAction | null {
    this.prune()
    return this.queries.get(queryId)?.listings.get(listingId) ?? null
  }

  append(
    queryId: string,
    listings: Array<{
      id: string
      whisper?: string
      characterName?: string
      instantBuyout: boolean
      merchantToken?: string
    }>,
  ): void {
    const existing = this.queries.get(queryId)
    const first = existing?.listings.values().next().value as RegisteredListingAction | undefined
    if (!first) return
    this.register(queryId, first.league, first.version, listings)
  }

  exactSearchUrl(listing: RegisteredListingAction): string {
    return getTradeUrls(listing.version).webSearch(listing.league, listing.queryId)
  }

  private prune(): void {
    const cutoff = this.now() - LISTING_TTL_MS
    for (const [queryId, entry] of this.queries) {
      if (entry.createdAt < cutoff) this.queries.delete(queryId)
    }
  }
}
