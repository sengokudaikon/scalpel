import { ipcMain, shell } from 'electron'
import type Store from 'electron-store'
import type { PoeAuthorizationPersistenceChoice } from '@shared/contracts/poe-auth'
import type { ListingActionRef, TradeActionResult } from '@shared/contracts/trade-actions'
import type { AppSettings } from '@shared/types'
import { getPoeOAuthManager } from '../auth/poe-oauth-runtime'
import { loadPoeOAuthConfig } from '../auth/poe-oauth-config'
import { getPoeVersion } from '../game-state'
import { trySendTradeChatAction } from '../hotkeys'
import { getProfileBackedSetting } from '../profiles/profile-settings'
import type { BulkExchangeResult, StatFilter, TradeResult } from '../trade/trade'
import {
  searchNeedsLogin,
  fetchMoreListings,
  getBulkExchangeId,
  isBulkExchangeItem,
  searchBulkExchange,
  searchMapsByRegex,
  searchTabletsByRegex,
  searchTrade,
  searchWaystonesByRegex,
  setTradeAccessTokenProvider,
} from '../trade/trade'
import { ListingActionRegistry } from '../trade/listing-action-registry'
import {
  ApprovedApiMerchantTravelProvider,
  ExternalBrowserMerchantTravelProvider,
  selectMerchantTravelProvider,
} from '../trade/merchant-travel'

const listingActions = new ListingActionRegistry()
const activeActions = new Set<string>()

function registerListings(queryId: string, league: string, listings: TradeResult['listings']): void {
  listingActions.register(queryId, league, getPoeVersion(), listings)
  // Merchant action tokens are main-process-only capabilities and must not
  // cross IPC with the renderer-facing listing.
  for (const listing of listings) delete listing.merchantToken
}

function actionFailure(
  action: 'whisper' | 'hideout' | 'instant-buy',
  reason: Extract<TradeActionResult, { ok: false }>['reason'],
  message: string,
  retryable = false,
): TradeActionResult {
  return { ok: false, action, reason, message, retryable }
}

async function runChatAction(ref: ListingActionRef, kind: 'whisper' | 'hideout'): Promise<TradeActionResult> {
  const listing = listingActions.get(ref.queryId, ref.listingId)
  if (!listing) return actionFailure(kind, 'listing-not-found', 'This fetched listing is no longer available.')
  if (listing.instantBuyout) {
    return actionFailure(kind, 'wrong-listing-kind', 'Instant-buy listings must be opened through Instant Buy.')
  }
  const text =
    kind === 'whisper' ? listing.whisper : listing.characterName ? `/hideout ${listing.characterName}` : undefined
  if (!text) {
    return actionFailure(
      kind,
      kind === 'whisper' ? 'missing-whisper' : 'missing-character',
      kind === 'whisper' ? 'The trade API did not provide a whisper.' : 'The listing has no seller character name.',
    )
  }
  const key = `${kind}:${ref.queryId}:${ref.listingId}`
  if (activeActions.has(key)) return actionFailure(kind, 'action-in-progress', 'That action is already in progress.')
  activeActions.add(key)
  try {
    const sent = await trySendTradeChatAction(text)
    if (sent === 'game-not-found') {
      return actionFailure(kind, 'game-not-found', 'Path of Exile could not be focused.', true)
    }
    if (sent === 'busy') return actionFailure(kind, 'action-in-progress', 'Another chat action is in progress.', true)
    return { ok: true, action: kind, mode: 'game-chat' }
  } catch {
    return actionFailure(kind, 'game-not-found', 'Path of Exile could not be focused.', true)
  } finally {
    activeActions.delete(key)
  }
}

export function register(store: Store<AppSettings>): void {
  const auth = getPoeOAuthManager()
  const oauthConfig = loadPoeOAuthConfig()
  setTradeAccessTokenProvider((forceRefresh) => auth.getAccessToken(forceRefresh), oauthConfig?.userAgent)
  const externalMerchant = new ExternalBrowserMerchantTravelProvider((url) => shell.openExternal(url))
  const approvedMerchant =
    oauthConfig?.instantBuyTravelApproved && oauthConfig.instantBuyTravelEndpoint
      ? new ApprovedApiMerchantTravelProvider(
          oauthConfig.instantBuyTravelEndpoint,
          oauthConfig.instantBuyTravelApproved,
          auth,
        )
      : null

  ipcMain.handle(
    'trade-search',
    async (
      _event,
      item: {
        name: string
        baseType: string
        itemClass: string
        rarity: string
        armour?: number
        evasion?: number
        energyShield?: number
        ward?: number
        block?: number
        vaalGem?: boolean
      },
      statFilters: StatFilter[],
      searchOptions?: { listedTime?: string; priceOption?: string; statusOption?: string },
    ): Promise<TradeResult> => {
      const league = getProfileBackedSetting(store, 'league')
      // Per-search overrides from the price-check Settings chip take priority over the
      // persisted global settings.
      const status = searchOptions?.statusOption ?? store.get('tradeStatus') ?? 'available'
      const price = searchOptions?.priceOption ?? getProfileBackedSetting(store, 'tradePriceOption') ?? 'chaos_divine'
      const collapse = store.get('tradeCollapseListings') ?? true
      // Only spend a login check when the search would carry a Weighted Sum group
      // (the trade API rejects those for anonymous users). Most searches skip it.
      const loggedIn = searchNeedsLogin(statFilters)
        ? (await auth.getAccessToken()) !== null && auth.getSnapshot().capabilities.authenticatedTrade
        : true
      const result = await searchTrade(league, item, statFilters, {
        tradeStatus: status,
        tradePriceOption: price,
        listedTime: searchOptions?.listedTime,
        collapseListings: collapse,
        loggedIn,
      })
      registerListings(result.queryId, league, result.listings)
      return result
    },
  )

  ipcMain.handle(
    'bulk-exchange',
    async (_event, itemName: string, baseType: string, haveId?: string): Promise<BulkExchangeResult> => {
      const league = getProfileBackedSetting(store, 'league')
      const wantId = getBulkExchangeId(itemName, baseType)
      if (!wantId) return { total: 0, listings: [], queryId: '' }
      return searchBulkExchange(league, wantId, haveId ?? 'chaos')
    },
  )

  ipcMain.handle(
    'check-bulk-item',
    (_event, itemName: string, baseType: string, itemClass: string, rarity?: string): boolean => {
      return isBulkExchangeItem(itemClass, itemName, baseType, rarity)
    },
  )

  ipcMain.handle('whisper-seller', (_event, ref: ListingActionRef) => runChatAction(ref, 'whisper'))

  ipcMain.handle('visit-hideout', (_event, ref: ListingActionRef) => runChatAction(ref, 'hideout'))

  ipcMain.handle('instant-buy', async (_event, ref: ListingActionRef): Promise<TradeActionResult> => {
    const listing = listingActions.get(ref.queryId, ref.listingId)
    if (!listing)
      return actionFailure('instant-buy', 'listing-not-found', 'This fetched listing is no longer available.')
    if (!listing.instantBuyout) {
      return actionFailure('instant-buy', 'wrong-listing-kind', 'This is an ordinary seller listing.')
    }
    const provider = selectMerchantTravelProvider(
      approvedMerchant && listing.merchantToken ? approvedMerchant : null,
      externalMerchant,
    )
    return provider.travel(listing, listingActions.exactSearchUrl(listing))
  })

  ipcMain.handle('poe-login', (_event, choice?: PoeAuthorizationPersistenceChoice) => auth.startAuthorization(choice))
  ipcMain.handle('poe-cancel-auth', () => auth.cancelAuthorization())
  ipcMain.handle('poe-check-auth', async () => {
    await auth.initialize()
    return auth.getSnapshot()
  })
  ipcMain.handle('poe-logout', () => auth.logout())

  ipcMain.handle('open-external', (_event, url: string) => {
    shell.openExternal(url)
  })

  ipcMain.handle(
    'map-regex-trade',
    async (
      _event,
      params: {
        tier: number
        avoidTexts: string[]
        wantTexts: string[]
        wantMode: 'any' | 'all'
        qualifiers: Record<string, number>
        nightmare: boolean
        originator: boolean
        corrupted8mod: boolean
      },
    ) => {
      const league = getProfileBackedSetting(store, 'league')
      const tradeStatus = store.get('tradeStatus') ?? 'available'
      const tradePriceOption = getProfileBackedSetting(store, 'tradePriceOption') ?? 'chaos_divine'
      const collapse = store.get('tradeCollapseListings') ?? true
      const result = await searchMapsByRegex(
        league,
        params.tier,
        params.avoidTexts,
        params.wantTexts,
        params.wantMode,
        params.qualifiers,
        params.nightmare,
        params.originator,
        params.corrupted8mod,
        tradeStatus,
        tradePriceOption,
        collapse,
      )
      registerListings(result.queryId, league, result.listings)
      return { ...result, league }
    },
  )

  ipcMain.handle(
    'waystone-regex-trade',
    async (
      _event,
      params: {
        tier: number
        avoidTexts: string[]
        wantTexts: string[]
        wantMode: 'any' | 'all'
        wantValues: Record<number, number>
        avoidValues: Record<number, number>
        qualifiers: {
          corrupted: boolean
          uncorrupted: boolean
          delirious: boolean
          anyPack: boolean
        }
        quantities: {
          packSize: number | null
          monsterEffectiveness: number | null
          monsterRarity: number | null
          itemRarity: number | null
          dropChance: number | null
        }
      },
    ) => {
      const league = getProfileBackedSetting(store, 'league')
      const tradeStatus = store.get('tradeStatus') ?? 'available'
      const tradePriceOption = getProfileBackedSetting(store, 'tradePriceOption') ?? 'chaos_divine'
      const collapse = store.get('tradeCollapseListings') ?? true
      const result = await searchWaystonesByRegex(
        league,
        params.tier,
        params.avoidTexts,
        params.wantTexts,
        params.wantMode,
        params.wantValues,
        params.avoidValues,
        params.qualifiers,
        params.quantities,
        tradeStatus,
        tradePriceOption,
        collapse,
      )
      registerListings(result.queryId, league, result.listings)
      return { ...result, league }
    },
  )

  ipcMain.handle(
    'tablet-regex-trade',
    async (
      _event,
      params: {
        wantTexts: string[]
        wantMode: 'any' | 'all'
        wantValues: Record<number, number>
        rarity: { normal: boolean; magic: boolean; rare: boolean }
        typeFlags: Record<string, boolean>
        uses: { enabled: boolean; value: number }
      },
    ) => {
      const league = getProfileBackedSetting(store, 'league')
      const tradeStatus = store.get('tradeStatus') ?? 'available'
      const tradePriceOption = getProfileBackedSetting(store, 'tradePriceOption') ?? 'chaos_divine'
      const collapse = store.get('tradeCollapseListings') ?? true
      const result = await searchTabletsByRegex(
        league,
        params.wantTexts,
        params.wantMode,
        params.wantValues,
        params.rarity,
        params.typeFlags,
        params.uses,
        tradeStatus,
        tradePriceOption,
        collapse,
      )
      registerListings(result.queryId, league, result.listings)
      return { ...result, league }
    },
  )

  ipcMain.handle('fetch-more-listings', async (_event, queryId: string, ids: string[]) => {
    const result = await fetchMoreListings(queryId, ids)
    listingActions.append(queryId, result.listings)
    for (const listing of result.listings) delete listing.merchantToken
    return result
  })
}
