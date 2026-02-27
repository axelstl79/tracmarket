'use strict'

/**
 * TracMarket — Autobase Contract
 *
 * Manages all durable replicated state:
 *   - Listings (post, update, remove)
 *   - Offers (send, counter, accept, decline)
 *   - Deals (immutable record of accepted trades)
 *   - Agent rules (auto-buy / auto-accept / auto-counter)
 *
 * All mutations go through base.append() so Autobase linearizes them
 * deterministically across all peers. Never write to external state in apply().
 */

const crypto = require('crypto')

let listingSeq = 0
let offerSeq = 0
let dealSeq = 0
let ruleSeq = 0

function nextId (prefix, seq) {
  return `${prefix}-${String(seq).padStart(3, '0')}`
}

// ── apply handler (called by Autobase on every linearized node) ──────────────

async function apply (nodes, view, host) {
  for (const node of nodes) {
    let entry
    try { entry = JSON.parse(node.value.toString()) } catch { continue }

    switch (entry.op) {

      // ── Listings ────────────────────────────────────────────────────────────

      case 'listing_post': {
        listingSeq++
        const id = nextId('LST', listingSeq)
        await view.put(id, JSON.stringify({
          id,
          title: entry.title,
          desc: entry.desc || '',
          price: entry.price,
          currency: entry.currency || 'TNK',
          category: entry.category || 'general',
          tags: entry.tags || '',
          seller: entry.seller,
          createdAt: entry.ts,
          status: 'active'
        }))
        break
      }

      case 'listing_update': {
        const raw = await view.get(entry.id)
        if (!raw) break
        const listing = JSON.parse(raw)
        if (listing.seller !== entry.seller) break // only owner
        if (entry.price !== undefined) listing.price = entry.price
        if (entry.desc !== undefined) listing.desc = entry.desc
        listing.updatedAt = entry.ts
        await view.put(entry.id, JSON.stringify(listing))
        break
      }

      case 'listing_remove': {
        const raw = await view.get(entry.id)
        if (!raw) break
        const listing = JSON.parse(raw)
        if (listing.seller !== entry.seller) break
        listing.status = 'removed'
        listing.removedAt = entry.ts
        await view.put(entry.id, JSON.stringify(listing))
        break
      }

      // ── Offers ──────────────────────────────────────────────────────────────

      case 'offer_send': {
        offerSeq++
        const offerId = nextId('OFR', offerSeq)
        const key = `${entry.listingId}:${offerId}`
        await view.put(key, JSON.stringify({
          id: offerId,
          listingId: entry.listingId,
          buyer: entry.buyer,
          amount: entry.amount,
          note: entry.note || '',
          status: 'pending',
          createdAt: entry.ts,
          history: [{ amount: entry.amount, by: entry.buyer, at: entry.ts }]
        }))
        break
      }

      case 'offer_counter': {
        const key = `${entry.listingId}:${entry.offerId}`
        const raw = await view.get(key)
        if (!raw) break
        const offer = JSON.parse(raw)
        if (offer.status !== 'pending') break
        offer.amount = entry.amount
        offer.status = 'pending'
        offer.history.push({ amount: entry.amount, by: entry.by, at: entry.ts })
        offer.lastUpdated = entry.ts
        await view.put(key, JSON.stringify(offer))
        break
      }

      case 'offer_accept': {
        const key = `${entry.listingId}:${entry.offerId}`
        const raw = await view.get(key)
        if (!raw) break
        const offer = JSON.parse(raw)
        if (offer.status !== 'pending') break
        offer.status = 'accepted'
        offer.acceptedAt = entry.ts
        offer.acceptedBy = entry.by
        await view.put(key, JSON.stringify(offer))

        // Create deal record
        dealSeq++
        const dealId = nextId('DEAL', dealSeq)
        const listingRaw = await view.get(entry.listingId)
        const listing = listingRaw ? JSON.parse(listingRaw) : {}
        await view.put(dealId, JSON.stringify({
          id: dealId,
          listingId: entry.listingId,
          offerId: entry.offerId,
          listingTitle: listing.title || '',
          buyer: offer.buyer,
          seller: listing.seller || entry.seller,
          finalPrice: offer.amount,
          currency: listing.currency || 'TNK',
          closedAt: entry.ts
        }))

        // Mark listing sold
        if (listingRaw) {
          listing.status = 'sold'
          listing.soldAt = entry.ts
          listing.dealId = dealId
          await view.put(entry.listingId, JSON.stringify(listing))
        }
        break
      }

      case 'offer_decline': {
        const key = `${entry.listingId}:${entry.offerId}`
        const raw = await view.get(key)
        if (!raw) break
        const offer = JSON.parse(raw)
        if (offer.status !== 'pending') break
        offer.status = 'declined'
        offer.declinedAt = entry.ts
        offer.declinedBy = entry.by
        await view.put(key, JSON.stringify(offer))
        break
      }

      // ── Agent Rules ─────────────────────────────────────────────────────────

      case 'rule_set': {
        ruleSeq++
        const ruleId = nextId('RULE', ruleSeq)
        const ruleKey = `rule:${entry.owner}:${ruleId}`
        await view.put(ruleKey, JSON.stringify({
          id: ruleId,
          owner: entry.owner,
          type: entry.ruleType,       // 'auto_buy' | 'auto_accept' | 'auto_counter'
          params: entry.params,
          createdAt: entry.ts
        }))
        break
      }

      case 'rule_delete': {
        const ruleKey = `rule:${entry.owner}:${entry.ruleId}`
        const raw = await view.get(ruleKey)
        if (!raw) break
        const rule = JSON.parse(raw)
        if (rule.owner !== entry.owner) break
        rule.deleted = true
        await view.put(ruleKey, JSON.stringify(rule))
        break
      }
    }
  }
}

// ── open handler — creates the Hyperbee view ─────────────────────────────────

function open (store) {
  const Hyperbee = require('hyperbee')
  return new Hyperbee(store.get('tracmarket-view'), {
    keyEncoding: 'utf-8',
    valueEncoding: 'utf-8'
  })
}

module.exports = { apply, open }
