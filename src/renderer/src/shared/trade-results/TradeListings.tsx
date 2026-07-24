import { Down, Up } from '@icon-park/react'
import type { Listing } from '../trade-types'
import { ExpandedListing } from './ExpandedListing'
import { SOCKET_IMGS, formatTimeAgo, socketLink, socketWhite } from './constants'
import { RuneSocketOverlayPoe2 } from '../../components/sockets/RuneSocketOverlay.poe2'
import { usePoeVersion } from '../poe-version-context'
import type { ResultsView } from '../trade-settings'
import { zebraRowBg } from '../utils'
import { CurrencyIcon } from '../CurrencyIcon'
import { formatPriceTooltip } from '../currency-short-labels'
import { HoverTooltip } from '../HoverTooltip'
import { useAuth } from '../use-auth'

export function TradeListings({
  listings,
  total,
  itemClass,
  itemName,
  itemRarity,
  expandedListing,
  setExpandedListing,
  priceChipMinWidth,
  loggedIn: _loggedIn,
  actionStatus,
  setActionStatus,
  queryId,
  league: _league,
  onLoadMore,
  loadingMore,
  resultsView = 'default',
}: {
  listings: Listing[]
  total: number | null
  itemClass: string
  itemName: string
  itemRarity: string
  expandedListing: string | null
  setExpandedListing: (id: string | null) => void
  priceChipMinWidth: number
  loggedIn: boolean
  actionStatus: Record<string, 'pending' | 'success' | 'failed'>
  setActionStatus: React.Dispatch<React.SetStateAction<Record<string, 'pending' | 'success' | 'failed'>>>
  queryId: string | null
  league: string
  onLoadMore?: () => void
  loadingMore?: boolean
  resultsView?: ResultsView
}): JSX.Element {
  const poeVersion = usePoeVersion()
  const { auth } = useAuth()
  const openAll = resultsView === 'open-all'
  const compact = resultsView === 'shrinkydink'
  const matchCount = total ?? listings.length
  return (
    <div className="relative flex-1 min-h-0 flex flex-col mx-[-14px] mt-0 -mb-[10px]">
      {matchCount > 0 && (
        // Anchored to this non-scrolling wrapper (not sticky inside the scroll
        // area), so it stays put on scroll. `-top` lifts it above the list top.
        <div className="absolute right-3 -top-[3px] z-10 pointer-events-none">
          <span className="rounded-full bg-black/50 px-[8px] py-[2px] text-[9px] font-semibold text-text-dim">
            {matchCount} {matchCount === 1 ? 'Match' : 'Matches'}
          </span>
        </div>
      )}
      <div className="bg-black/20 overflow-hidden flex-1 min-h-0 overflow-y-auto rounded-none">
        {listings.map((l, i) => {
          const isExpanded = openAll || expandedListing === l.id
          return (
            <div key={l.id}>
              <div
                onClick={() => {
                  if (openAll) return
                  setExpandedListing(isExpanded ? null : l.id)
                }}
                className="flex items-center gap-2 px-[10px] py-[6px] text-xs relative transition-[background] duration-100"
                style={{
                  background: zebraRowBg(i),
                  borderLeft: isExpanded ? '3px solid var(--accent)' : '3px solid transparent',
                  cursor: openAll ? 'default' : 'pointer',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(255,255,255,0.06)'
                  const chev = e.currentTarget.querySelector('.row-chevron') as HTMLElement
                  if (chev) chev.style.opacity = '0.5'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = zebraRowBg(i)
                  const chev = e.currentTarget.querySelector('.row-chevron') as HTMLElement
                  if (chev) chev.style.opacity = isExpanded ? '0.5' : '0'
                }}
              >
                {/* Item icon with sockets overlay (hidden in Shrinkydink mode) */}
                {!compact && l.icon && (
                  <div className="relative w-[42px] h-[44px] shrink-0">
                    <img
                      src={l.icon}
                      alt=""
                      className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 object-contain pointer-events-none"
                      style={{
                        width: 72,
                        height: 72,
                        filter: 'blur(10px) saturate(2)',
                        opacity: 0.3,
                      }}
                    />
                    <img src={l.icon} alt="" className="relative w-[42px] h-[44px] object-contain" />
                    {/* Sockets overlay */}
                    {l.itemData?.sockets && l.itemData.sockets.length > 0 && (
                      <div
                        className="absolute left-0 right-0 bottom-0 flex flex-col items-center justify-center pointer-events-none"
                        style={{
                          top: l.itemData?.sockets && l.itemData.sockets.length >= 5 ? -5 : 0,
                        }}
                      >
                        {(() => {
                          const sockets = l.itemData!.sockets!
                          const n = sockets.length
                          const sz = 12,
                            gap = 3

                          if (poeVersion === 2) {
                            return (
                              <RuneSocketOverlayPoe2
                                count={n}
                                itemClass={itemClass}
                                itemName={itemName}
                                sz={sz}
                                gap={gap}
                              />
                            )
                          }

                          const is1Wide =
                            n <= 3 && !['Helmets', 'Body Armours', 'Gloves', 'Boots', 'Shields'].includes(itemClass)

                          if (is1Wide || n <= 1) {
                            return sockets.map((s, si) => {
                              const linked = si > 0 && sockets[si - 1].group === s.group
                              return (
                                <div key={si} className="flex flex-col items-center">
                                  {linked && (
                                    <img
                                      src={socketLink}
                                      alt=""
                                      style={{
                                        width: 4,
                                        height: gap,
                                        objectFit: 'fill',
                                        transform: 'rotate(90deg)',
                                        filter: 'brightness(2)',
                                      }}
                                    />
                                  )}
                                  {!linked && si > 0 && <div style={{ height: gap }} />}
                                  <img
                                    src={SOCKET_IMGS[s.sColour] ?? socketWhite}
                                    alt=""
                                    style={{ width: sz, height: sz }}
                                  />
                                </div>
                              )
                            })
                          }

                          // Zigzag positions
                          const positions: Array<[number, number]> = []
                          for (let row = 0; row < Math.ceil(n / 2); row++) {
                            if (row % 2 === 0) {
                              positions.push([0, row])
                              if (positions.length < n) positions.push([1, row])
                            } else {
                              positions.push([1, row])
                              if (positions.length < n) positions.push([0, row])
                            }
                          }

                          const cellW = sz + gap * 2
                          const cellH = sz + gap * 2
                          const totalW = cellW * 2
                          const totalH = cellH * Math.ceil(n / 2)

                          return (
                            <div className="relative overflow-visible" style={{ width: totalW, height: totalH }}>
                              {sockets.map((s, si) => {
                                const [col, row] = positions[si]
                                const x = col * cellW + gap
                                const y = row * cellH + gap

                                let linkEl = null
                                if (si > 0 && sockets[si - 1].group === s.group) {
                                  const [pc, pr] = positions[si - 1]
                                  if (pr === row) {
                                    linkEl = (
                                      <img
                                        key={`l${si}`}
                                        src={socketLink}
                                        alt=""
                                        style={{
                                          position: 'absolute',
                                          left: Math.min(col, pc) * cellW + gap + sz,
                                          top: y + (sz - 4) / 2,
                                          width: gap * 2,
                                          height: 4,
                                          objectFit: 'fill',
                                          filter: 'brightness(2)',
                                        }}
                                      />
                                    )
                                  } else {
                                    linkEl = (
                                      <img
                                        key={`l${si}`}
                                        src={socketLink}
                                        alt=""
                                        style={{
                                          position: 'absolute',
                                          left: col * cellW + gap + (sz - gap * 2) / 2,
                                          top: Math.min(row, pr) * cellH + gap + sz + (gap * 2 - 4) / 2,
                                          width: gap * 2,
                                          height: 4,
                                          objectFit: 'fill',
                                          transform: 'rotate(90deg)',
                                          filter: 'brightness(2)',
                                        }}
                                      />
                                    )
                                  }
                                }

                                return [
                                  linkEl,
                                  <img
                                    key={si}
                                    src={SOCKET_IMGS[s.sColour] ?? socketWhite}
                                    alt=""
                                    style={{
                                      position: 'absolute',
                                      left: x,
                                      top: y,
                                      width: sz,
                                      height: sz,
                                    }}
                                  />,
                                ]
                              })}
                            </div>
                          )
                        })()}
                      </div>
                    )}
                  </div>
                )}

                {/* Price */}
                {l.price ? (
                  <HoverTooltip text={formatPriceTooltip(l.price.amount, l.price.currency)} className="shrink-0">
                    <span
                      className="flex items-center justify-center gap-1 font-bold text-sm font-[inherit] bg-black/30 rounded-full px-[10px] py-[3px]"
                      style={{ minWidth: priceChipMinWidth }}
                    >
                      {l.price.amount}
                      <CurrencyIcon name={l.price.currency} className="w-[18px] h-[18px]" />
                    </span>
                  </HoverTooltip>
                ) : (
                  <span
                    className="flex items-center justify-center shrink-0 text-text-dim text-[11px] bg-black/30 rounded-full px-[10px] py-[3px]"
                    style={{ minWidth: priceChipMinWidth }}
                  >
                    No price
                  </span>
                )}

                {/* Seller + time: stacked by default, inline in Shrinkydink to save vertical space */}
                <div className={`flex-1 min-w-0 flex ${compact ? 'items-center gap-2' : 'flex-col'}`}>
                  <span
                    className="text-[10px] truncate"
                    style={{ color: l.online ? 'var(--accent)' : 'var(--text-dim)' }}
                  >
                    {l.account}
                  </span>
                  {l.indexed && (
                    <span className="text-[9px] text-text-dim whitespace-nowrap">{formatTimeAgo(l.indexed)}</span>
                  )}
                </div>

                {/* Every game action is a separate manual click and returns an explicit result. */}
                {queryId &&
                  (() => {
                    const whisperKey = `${l.id}:whisper`
                    const hideoutKey = `${l.id}:hideout`
                    const instantKey = `${l.id}:instant`
                    const run = async (
                      event: React.MouseEvent,
                      key: string,
                      invoke: () => Promise<import('@shared/types').TradeActionResult>,
                    ): Promise<void> => {
                      event.stopPropagation()
                      if (actionStatus[key] === 'pending') return
                      setActionStatus((prev) => ({ ...prev, [key]: 'pending' }))
                      try {
                        const result = await invoke()
                        setActionStatus((prev) => ({ ...prev, [key]: result.ok ? 'success' : 'failed' }))
                      } catch {
                        setActionStatus((prev) => ({ ...prev, [key]: 'failed' }))
                      }
                    }
                    const actionClass =
                      'px-2 py-[3px] text-[9px] font-semibold border-none rounded-[3px] shrink-0 whitespace-nowrap bg-white/[0.06] hover:bg-white/[0.12] text-text-dim hover:text-text disabled:opacity-50'
                    if (l.instantBuyout) {
                      const status = actionStatus[instantKey]
                      const approved = auth?.capabilities.instantBuyTravel === true
                      return (
                        <button
                          className={actionClass}
                          disabled={status === 'pending'}
                          title={
                            approved
                              ? 'Use the GGG-approved instant-buy travel action'
                              : 'Open this exact instant-buy search in your browser'
                          }
                          onClick={(event) =>
                            void run(event, instantKey, () => window.api.requestInstantBuy(queryId, l.id))
                          }
                        >
                          {status === 'pending'
                            ? approved
                              ? 'Traveling…'
                              : 'Opening…'
                            : status === 'failed'
                              ? 'Failed'
                              : approved
                                ? 'Travel to Hideout'
                                : 'Open Instant Buy'}
                        </button>
                      )
                    }
                    const whisperStatus = actionStatus[whisperKey]
                    const hideoutStatus = actionStatus[hideoutKey]
                    return (
                      <div className="flex items-center gap-1">
                        {l.whisper && (
                          <>
                            <button
                              className={actionClass}
                              disabled={whisperStatus === 'pending' || whisperStatus === 'success'}
                              title="Send the API-provided whisper as one manually invoked chat action"
                              onClick={(event) =>
                                void run(event, whisperKey, () => window.api.whisperSeller(queryId, l.id))
                              }
                            >
                              {whisperStatus === 'pending'
                                ? 'Whispering…'
                                : whisperStatus === 'success'
                                  ? 'Whisper Sent'
                                  : whisperStatus === 'failed'
                                    ? 'Retry Whisper'
                                    : 'Whisper Seller'}
                            </button>
                            <button
                              className={actionClass}
                              title="Copy the API-provided whisper without controlling the game"
                              onClick={(event) => {
                                event.stopPropagation()
                                void navigator.clipboard.writeText(l.whisper!)
                              }}
                            >
                              Copy Whisper
                            </button>
                          </>
                        )}
                        {whisperStatus === 'success' && l.characterName && (
                          <button
                            className={actionClass}
                            disabled={hideoutStatus === 'pending'}
                            title={`Send /hideout ${l.characterName} as one manually invoked command`}
                            onClick={(event) =>
                              void run(event, hideoutKey, () => window.api.visitHideout(queryId, l.id))
                            }
                          >
                            {hideoutStatus === 'pending'
                              ? 'Visiting…'
                              : hideoutStatus === 'success'
                                ? 'Hideout Command Sent'
                                : hideoutStatus === 'failed'
                                  ? 'Retry Hideout'
                                  : 'Visit Hideout'}
                          </button>
                        )}
                      </div>
                    )
                  })()}

                {/* Expand/collapse chevron (hidden when Open All forces everything expanded) */}
                <span
                  className="absolute bottom-0 left-1/2 -translate-x-1/2 text-text-dim pointer-events-none flex transition-opacity duration-150 row-chevron"
                  style={{
                    opacity: openAll ? 0 : isExpanded ? 0.5 : 0,
                  }}
                >
                  {isExpanded ? (
                    <Up size={12} theme="two-tone" fill={['currentColor', 'rgba(255,255,255,0.2)']} />
                  ) : (
                    <Down size={12} theme="two-tone" fill={['currentColor', 'rgba(255,255,255,0.2)']} />
                  )}
                </span>
              </div>

              {/* Expanded item details (also shown for every row in Open All mode) */}
              {isExpanded && l.itemData && (
                <ExpandedListing listing={l} itemClass={itemClass} itemName={itemName} itemRarity={itemRarity} />
              )}
            </div>
          )
        })}
        {total != null && total > listings.length && (
          <div className="px-[10px] py-1 text-[9px] text-text-dim text-center">
            Showing {listings.length} of {total} results
            {onLoadMore && (
              <button
                style={{ marginLeft: 6 }}
                onClick={onLoadMore}
                disabled={loadingMore}
                className="text-[9px] px-[6px] py-[1px] border-none cursor-pointer font-semibold bg-white/[0.06] text-text-dim rounded-[2px] disabled:opacity-40"
                onMouseEnter={(e) => {
                  if (!loadingMore) e.currentTarget.style.background = 'rgba(255,255,255,0.12)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'rgba(255,255,255,0.06)'
                }}
              >
                {loadingMore ? 'Loading...' : 'Load more'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
