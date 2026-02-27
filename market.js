'use strict'

/**
 * TracMarket — Core Market Module
 *
 * Handles:
 *  - Incoming sidechannel events (listings, offers, deals)
 *  - Agent rule evaluation (auto-buy, auto-accept, auto-counter)
 *  - Display formatting for the terminal
 */

const { EventEmitter } = require('events')

const DEAL_RATE_WINDOW_MS = 60 * 60 * 1000 // 1 hour

class Market extends EventEmitter {
  /**
   * @param {object} protocol  TracMarketProtocol instance
   * @param {string} address   This peer's Trac address
   * @param {boolean} agentMode  Run rule engine in background
   */
  constructor (protocol, address, agentMode = false) {
    super()
    this.protocol = protocol
    this.address = address
    this.agentMode = agentMode

    this.knownListings = new Map()   // id → listing
    this.dealTimestamps = []         // for rate-limiting

    this._bindSidechannelEvents()
  }

  // ── Sidechannel event handler ─────────────────────────────────────────────

  _bindSidechannelEvents () {
    // The Intercom sc feature emits 'sc_message' with { channel, data, from }
    this.protocol.sc.on('sc_message', async ({ channel, data, from }) => {
      let msg
      try { msg = JSON.parse(data) } catch { return }

      if (channel === 'tracmarket') {
        await this._onPublicChannelEvent(msg, from)
      } else if (channel.startsWith('deal-')) {
        const listingId = channel.slice(5)
        await this._onDealChannelEvent(listingId, msg, from)
      }
    })
  }

  async _onPublicChannelEvent (msg, from) {
    switch (msg.event) {
      case 'LISTING_POST': {
        const listing = { ...msg, seller: from }
        this.knownListings.set(msg.id || msg.title, listing)
        console.log(`\n📢 [tracmarket] New listing from ${from.slice(0, 12)}…: "${msg.title}" — ${msg.price} ${msg.currency || 'TNK'} [${msg.category}]`)
        if (this.agentMode) await this._evalBuyRules(listing)
        break
      }
      case 'LISTING_UPDATE':
        console.log(`\n🔄 [tracmarket] Listing ${msg.id} updated — new price: ${msg.price} TNK`)
        break
      case 'LISTING_REMOVE':
        console.log(`\n❌ [tracmarket] Listing ${msg.id} removed by seller`)
        this.knownListings.delete(msg.id)
        break
      case 'DEAL_CLOSED':
        console.log(`\n🤝 [tracmarket] Deal closed on listing ${msg.listingId}`)
        break
    }
  }

  async _onDealChannelEvent (listingId, msg, from) {
    switch (msg.event) {
      case 'OFFER_SENT':
        console.log(`\n💬 [deal-${listingId}] Offer from ${from.slice(0, 12)}…: ${msg.amount} TNK${msg.note ? ` — "${msg.note}"` : ''}`)
        if (this.agentMode) await this._evalAcceptRules(listingId, msg)
        break
      case 'OFFER_COUNTER':
        console.log(`\n💬 [deal-${listingId}] Counter from ${from.slice(0, 12)}…: ${msg.amount} TNK`)
        break
      case 'OFFER_ACCEPTED':
        console.log(`\n🎉 [deal-${listingId}] Offer ${msg.offerId} ACCEPTED by ${from.slice(0, 12)}…`)
        break
      case 'OFFER_DECLINED':
        console.log(`\n🚫 [deal-${listingId}] Offer ${msg.offerId} declined`)
        break
    }
  }

  // ── Agent rule evaluation ─────────────────────────────────────────────────

  async _evalBuyRules (listing) {
    const result = await this.protocol.handle({ op: 'rule_list' })
    const rules = result.data || []

    for (const rule of rules) {
      if (rule.type !== 'auto_buy') continue
      if (rule.params.category && rule.params.category !== listing.category) continue
      if (listing.price > rule.params.max_price) continue
      if (!this._checkRateLimit(10)) {
        console.log('[AGENT] Rate limit hit — skipping auto-buy')
        return
      }
      console.log(`[AGENT] Auto-buy triggered: "${listing.title}" at ${listing.price} TNK`)
      // Join deal channel
      this.protocol.sc.join(`deal-${listing.id}`)
      // Send offer at asking price
      await this.protocol.handle({
        op: 'offer_send',
        listing_id: listing.id,
        amount: listing.price,
        note: 'Auto-buy: accepting ask price'
      })
    }
  }

  async _evalAcceptRules (listingId, offerMsg) {
    const result = await this.protocol.handle({ op: 'rule_list' })
    const rules = result.data || []

    for (const rule of rules) {
      if (rule.type === 'auto_accept' && rule.params.listingId === listingId) {
        if (offerMsg.amount >= rule.params.min_price) {
          console.log(`[AGENT] Auto-accept triggered: ${offerMsg.amount} TNK ≥ floor ${rule.params.min_price}`)
          await this.protocol.handle({
            op: 'offer_accept',
            listing_id: listingId,
            offer_id: offerMsg.offerId
          })
          return
        }
      }

      if (rule.type === 'auto_counter' && rule.params.listingId === listingId) {
        // Look up listing price to compute counter
        const listingResult = await this.protocol.handle({ op: 'listing_get', id: listingId })
        if (!listingResult.ok) continue
        const floor = Math.floor(listingResult.data.price * rule.params.ratio)
        if (offerMsg.amount < floor) {
          console.log(`[AGENT] Auto-counter: ${offerMsg.amount} < floor ${floor} → countering at ${floor}`)
          await this.protocol.handle({
            op: 'offer_counter',
            listing_id: listingId,
            offer_id: offerMsg.offerId,
            amount: floor
          })
        } else {
          console.log(`[AGENT] Auto-accept (counter ratio): ${offerMsg.amount} ≥ floor ${floor}`)
          await this.protocol.handle({
            op: 'offer_accept',
            listing_id: listingId,
            offer_id: offerMsg.offerId
          })
        }
        return
      }
    }
  }

  _checkRateLimit (maxPerHour) {
    const now = Date.now()
    this.dealTimestamps = this.dealTimestamps.filter(t => now - t < DEAL_RATE_WINDOW_MS)
    if (this.dealTimestamps.length >= maxPerHour) return false
    this.dealTimestamps.push(now)
    return true
  }

  // ── Display helpers ───────────────────────────────────────────────────────

  static formatListings (listings) {
    if (!listings.length) return '  (no active listings)'
    const lines = listings.map(l =>
      `  ${l.id.padEnd(9)} ${String(l.price).padStart(6)} ${(l.currency || 'TNK').padEnd(4)}  [${l.category.padEnd(10)}]  "${l.title}"`)
    return lines.join('\n')
  }

  static formatDeal (deal) {
    return [
      `  Deal:    ${deal.id}`,
      `  Item:    ${deal.listingTitle}`,
      `  Price:   ${deal.finalPrice} ${deal.currency}`,
      `  Buyer:   ${deal.buyer}`,
      `  Seller:  ${deal.seller}`,
      `  Closed:  ${new Date(deal.closedAt).toISOString()}`
    ].join('\n')
  }
}

module.exports = Market
