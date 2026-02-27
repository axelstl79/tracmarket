'use strict'

/**
 * TracMarket — Protocol / Command Router
 *
 * Parses /tx --command JSON payloads and dispatches to the correct
 * contract operation or read query. Follows the same pattern as the
 * upstream Intercom reference protocol.
 */

const { EventEmitter } = require('events')

class TracMarketProtocol extends EventEmitter {
  constructor (base, view, selfAddress, sidechannel) {
    super()
    this.base = base           // Autobase instance
    this.view = view           // Hyperbee view
    this.address = selfAddress // this peer's Trac address
    this.sc = sidechannel      // Intercom sidechannel for broadcasts
  }

  // ── Entry point called by Intercom's /tx handler ──────────────────────────

  async handle (raw) {
    let cmd
    try { cmd = typeof raw === 'string' ? JSON.parse(raw) : raw } catch {
      return this._err('Invalid JSON command')
    }

    const { op } = cmd
    if (!op) return this._err('Missing op field')

    switch (op) {

      // ── Listing mutations ─────────────────────────────────────────────────

      case 'listing_post':
        return this._listingPost(cmd)
      case 'listing_update':
        return this._listingUpdate(cmd)
      case 'listing_remove':
        return this._listingRemove(cmd)

      // ── Listing reads ─────────────────────────────────────────────────────

      case 'listing_list':
        return this._listingList(cmd)
      case 'listing_get':
        return this._listingGet(cmd)

      // ── Offer mutations ───────────────────────────────────────────────────

      case 'offer_send':
        return this._offerSend(cmd)
      case 'offer_counter':
        return this._offerCounter(cmd)
      case 'offer_accept':
        return this._offerAccept(cmd)
      case 'offer_decline':
        return this._offerDecline(cmd)

      // ── Deal reads ────────────────────────────────────────────────────────

      case 'deal_list':
        return this._dealList(cmd)
      case 'deal_get':
        return this._dealGet(cmd)

      // ── Agent rules ───────────────────────────────────────────────────────

      case 'rule_set':
        return this._ruleSet(cmd)
      case 'rule_list':
        return this._ruleList(cmd)
      case 'rule_delete':
        return this._ruleDelete(cmd)

      default:
        return this._err(`Unknown op: ${op}`)
    }
  }

  // ── Listing mutations ─────────────────────────────────────────────────────

  async _listingPost (cmd) {
    const { title, desc, price, currency, category, tags } = cmd
    if (!title) return this._err('listing_post requires title')
    if (typeof price !== 'number' || price < 0) return this._err('listing_post requires numeric price')

    await this.base.append(JSON.stringify({
      op: 'listing_post', title, desc: desc || '', price,
      currency: currency || 'TNK',
      category: category || 'general',
      tags: tags || '',
      seller: this.address,
      ts: Date.now()
    }))

    // Broadcast to public tracmarket channel
    this.sc.broadcast('tracmarket', JSON.stringify({
      event: 'LISTING_POST',
      title, price, currency: currency || 'TNK',
      category: category || 'general',
      seller: this.address
    }))

    return this._ok('Listing posted to tracmarket channel')
  }

  async _listingUpdate (cmd) {
    const { id, price, desc } = cmd
    if (!id) return this._err('listing_update requires id')
    await this.base.append(JSON.stringify({
      op: 'listing_update', id, price, desc,
      seller: this.address, ts: Date.now()
    }))
    if (price !== undefined) {
      this.sc.broadcast('tracmarket', JSON.stringify({ event: 'LISTING_UPDATE', id, price }))
    }
    return this._ok(`Listing ${id} updated`)
  }

  async _listingRemove (cmd) {
    const { id } = cmd
    if (!id) return this._err('listing_remove requires id')
    await this.base.append(JSON.stringify({
      op: 'listing_remove', id, seller: this.address, ts: Date.now()
    }))
    this.sc.broadcast('tracmarket', JSON.stringify({ event: 'LISTING_REMOVE', id }))
    return this._ok(`Listing ${id} removed`)
  }

  // ── Listing reads ─────────────────────────────────────────────────────────

  async _listingList (cmd) {
    const { limit = 20, category, max_price, mine } = cmd
    const results = []
    for await (const entry of this.view.createReadStream()) {
      const key = entry.key
      if (!key.startsWith('LST-')) continue
      const listing = JSON.parse(entry.value)
      if (listing.status !== 'active') continue
      if (category && listing.category !== category) continue
      if (max_price !== undefined && listing.price > max_price) continue
      if (mine && listing.seller !== this.address) continue
      results.push(listing)
      if (results.length >= limit) break
    }
    return this._ok(null, results)
  }

  async _listingGet (cmd) {
    const { id } = cmd
    if (!id) return this._err('listing_get requires id')
    const raw = await this.view.get(id)
    if (!raw) return this._err(`Listing ${id} not found`)
    return this._ok(null, JSON.parse(raw.value))
  }

  // ── Offer mutations ───────────────────────────────────────────────────────

  async _offerSend (cmd) {
    const { listing_id, amount, note } = cmd
    if (!listing_id) return this._err('offer_send requires listing_id')
    if (typeof amount !== 'number') return this._err('offer_send requires numeric amount')

    await this.base.append(JSON.stringify({
      op: 'offer_send', listingId: listing_id,
      buyer: this.address, amount, note: note || '', ts: Date.now()
    }))

    this.sc.broadcast(`deal-${listing_id}`, JSON.stringify({
      event: 'OFFER_SENT', amount, note: note || '', buyer: this.address
    }))

    return this._ok('Offer sent')
  }

  async _offerCounter (cmd) {
    const { listing_id, offer_id, amount } = cmd
    if (!listing_id || !offer_id) return this._err('offer_counter requires listing_id and offer_id')
    if (typeof amount !== 'number') return this._err('offer_counter requires numeric amount')

    await this.base.append(JSON.stringify({
      op: 'offer_counter', listingId: listing_id, offerId: offer_id,
      amount, by: this.address, ts: Date.now()
    }))

    this.sc.broadcast(`deal-${listing_id}`, JSON.stringify({
      event: 'OFFER_COUNTER', offerId: offer_id, amount, by: this.address
    }))

    return this._ok(`Counter-offer sent: ${amount} TNK`)
  }

  async _offerAccept (cmd) {
    const { listing_id, offer_id } = cmd
    if (!listing_id || !offer_id) return this._err('offer_accept requires listing_id and offer_id')

    await this.base.append(JSON.stringify({
      op: 'offer_accept', listingId: listing_id, offerId: offer_id,
      by: this.address, seller: this.address, ts: Date.now()
    }))

    // Broadcast deal close to both channels
    const dealMsg = JSON.stringify({ event: 'OFFER_ACCEPTED', offerId: offer_id, by: this.address })
    this.sc.broadcast(`deal-${listing_id}`, dealMsg)
    this.sc.broadcast('tracmarket', JSON.stringify({
      event: 'DEAL_CLOSED', listingId: listing_id
    }))

    return this._ok(`Deal accepted! Recorded on-chain.`)
  }

  async _offerDecline (cmd) {
    const { listing_id, offer_id } = cmd
    if (!listing_id || !offer_id) return this._err('offer_decline requires listing_id and offer_id')

    await this.base.append(JSON.stringify({
      op: 'offer_decline', listingId: listing_id, offerId: offer_id,
      by: this.address, ts: Date.now()
    }))

    this.sc.broadcast(`deal-${listing_id}`, JSON.stringify({
      event: 'OFFER_DECLINED', offerId: offer_id, by: this.address
    }))

    return this._ok('Offer declined')
  }

  // ── Deal reads ────────────────────────────────────────────────────────────

  async _dealList (cmd) {
    const { limit = 10, mine } = cmd
    const results = []
    for await (const entry of this.view.createReadStream()) {
      if (!entry.key.startsWith('DEAL-')) continue
      const deal = JSON.parse(entry.value)
      if (mine && deal.buyer !== this.address && deal.seller !== this.address) continue
      results.push(deal)
      if (results.length >= limit) break
    }
    return this._ok(null, results)
  }

  async _dealGet (cmd) {
    const { id } = cmd
    if (!id) return this._err('deal_get requires id')
    const raw = await this.view.get(id)
    if (!raw) return this._err(`Deal ${id} not found`)
    return this._ok(null, JSON.parse(raw.value))
  }

  // ── Agent rules ───────────────────────────────────────────────────────────

  async _ruleSet (cmd) {
    const { category, listing_id, auto_buy_below, auto_accept_above, auto_counter_ratio, max_deals_per_hour } = cmd

    let ruleType, params
    if (auto_buy_below !== undefined) {
      ruleType = 'auto_buy'
      params = { category, max_price: auto_buy_below }
    } else if (auto_accept_above !== undefined) {
      ruleType = 'auto_accept'
      params = { listingId: listing_id, min_price: auto_accept_above }
    } else if (auto_counter_ratio !== undefined) {
      ruleType = 'auto_counter'
      params = { listingId: listing_id, ratio: auto_counter_ratio }
    } else {
      return this._err('rule_set: specify auto_buy_below, auto_accept_above, or auto_counter_ratio')
    }

    await this.base.append(JSON.stringify({
      op: 'rule_set', ruleType, params,
      owner: this.address, ts: Date.now()
    }))

    return this._ok(`Rule set: ${ruleType}`)
  }

  async _ruleList () {
    const results = []
    const prefix = `rule:${this.address}:`
    for await (const entry of this.view.createReadStream({ gte: prefix, lte: prefix + '\xff' })) {
      const rule = JSON.parse(entry.value)
      if (!rule.deleted) results.push(rule)
    }
    return this._ok(null, results)
  }

  async _ruleDelete (cmd) {
    const { rule_id } = cmd
    if (!rule_id) return this._err('rule_delete requires rule_id')
    await this.base.append(JSON.stringify({
      op: 'rule_delete', ruleId: rule_id, owner: this.address, ts: Date.now()
    }))
    return this._ok(`Rule ${rule_id} deleted`)
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  _ok (msg, data) {
    const out = { ok: true }
    if (msg) out.message = msg
    if (data !== undefined) out.data = data
    return out
  }

  _err (msg) {
    return { ok: false, error: msg }
  }
}

module.exports = TracMarketProtocol
