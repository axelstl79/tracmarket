'use strict'

/**
 * TracMarket — Main Entry Point
 *
 * Run with Pear runtime:
 *   pear run . --seller                     (create market topic, post listings)
 *   pear run . --join <topic-key>           (browse and buy)
 *
 * Agent modes:
 *   pear run . --seller --agent --listings-file ./listings.json
 *   pear run . --join <topic-key> --agent --role buyer --budget 500 --category electronics
 */

const Hyperswarm     = require('hyperswarm')
const crypto         = require('hypercore-crypto')
const b4a            = require('b4a')
const MarketApp      = require('./features/market-cli.js')

// ── Parse args ────────────────────────────────────────────────────────────────

const args           = process.argv.slice(2)
const isSeller       = args.includes('--seller')
const joinIdx        = args.indexOf('--join')
const topicHex       = joinIdx !== -1 ? args[joinIdx + 1] : null
const isAgent        = args.includes('--agent')
const roleIdx        = args.indexOf('--role');          const agentRole    = roleIdx !== -1 ? args[roleIdx + 1] : 'buyer'
const budgetIdx      = args.indexOf('--budget');        const agentBudget  = budgetIdx !== -1 ? parseFloat(args[budgetIdx + 1]) : Infinity
const categoryIdx    = args.indexOf('--category');      const agentCat     = categoryIdx !== -1 ? args[categoryIdx + 1] : null
const listingsIdx    = args.indexOf('--listings-file'); const listingsFile = listingsIdx !== -1 ? args[listingsIdx + 1] : null

// ── Minimal Intercom shim ─────────────────────────────────────────────────────

class IntercomShim {
  constructor () {
    this.swarm      = new Hyperswarm()
    this._listeners = []
    this._peers     = new Map()  // peerId → socket
    this.base       = null
  }

  on (event, fn) { if (event === 'message') this._listeners.push(fn) }

  broadcast (payload) {
    const buf = b4a.from(payload)
    for (const socket of this._peers.values()) { try { socket.write(buf) } catch {} }
  }

  async send (peerId, payload) {
    // In a real Intercom implementation this routes directly to a specific peer.
    // Here we broadcast (safe for small networks; real impl would be point-to-point).
    this.broadcast(payload)
  }

  _emit (raw, from) { for (const fn of this._listeners) fn(raw, from) }

  async join (topicKey) {
    this.swarm.join(topicKey, { server: isSeller, client: true })
    this.swarm.on('connection', (socket, info) => {
      const pid = info.publicKey.toString('hex')
      this._peers.set(pid, socket)
      socket.on('data',  d  => this._emit(d.toString(), pid))
      socket.on('close', () => this._peers.delete(pid))
      socket.on('error', () => this._peers.delete(pid))
      console.log(`🔗 Peer connected: ${pid.slice(0, 8)}…`)
    })
    await this.swarm.flush()
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

async function main () {
  let topicKey

  if (isSeller) {
    topicKey = crypto.randomBytes(32)
    console.log(`\n🔑 Market topic key (share with buyers): ${topicKey.toString('hex')}\n`)
  } else if (topicHex) {
    topicKey = b4a.from(topicHex, 'hex')
  } else {
    console.error([
      'Usage:',
      '  pear run . --seller                    (start a market)',
      '  pear run . --join <topic-key>          (join a market)'
    ].join('\n'))
    process.exit(1)
  }

  // Generate ephemeral identity (production: persist keypair to disk)
  const keyPair     = crypto.keyPair()
  const tracAddress = keyPair.publicKey.toString('hex').slice(0, 40)
  console.log(`📛 Your Trac address: ${tracAddress}`)

  // Spin up Intercom shim with in-memory Autobase stub
  const intercom = new IntercomShim()
  const store    = new Map()

  intercom.base = {
    view: {
      async get (key) {
        const v = store.get(key.toString())
        return v ? Buffer.from(v) : null
      }
    },
    async append (data) {
      try {
        const { op, key, value } = JSON.parse(data)
        if (op === 'PUT') store.set(key, JSON.stringify(value))
      } catch {}
    }
  }

  await intercom.join(topicKey)

  const app = new MarketApp(intercom, tracAddress)

  // ── Agent mode ────────────────────────────────────────────────────────────

  if (isAgent) {
    console.log(`\n🤖 Agent mode: ${agentRole}`)

    if (agentRole === 'seller' && listingsFile) {
      // Post listings from JSON file on startup
      try {
        const listings = JSON.parse(require('fs').readFileSync(listingsFile, 'utf8'))
        for (const l of listings) {
          const id = await app.postListing(l.title, l.description, l.price, l.category, l.negotiable || false)
          console.log(`🤖 Posted: ${id} — "${l.title}" @ ${l.price} TNK`)
        }
      } catch (e) { console.error(`Failed to load listings: ${e.message}`) }

      // Auto-respond to incoming offers
      setInterval(async () => {
        for (const [offerId, offer] of app.incomingOffers) {
          if (offer.status !== 'PENDING' && offer.status !== 'COUNTERED') continue
          const listing = app.listings.get(offer.listingId)
          if (!listing) continue
          const ask    = listing.price
          const bid    = offer.currentPrice
          const ratio  = bid / ask

          try {
            if (ratio >= 0.90) {
              await app.acceptOffer(offerId)
              console.log(`🤖 Auto-accepted offer ${offerId} (${Math.round(ratio * 100)}% of ask)`)
            } else if (ratio >= 0.80) {
              const counter = Math.round(ask * 0.95)
              await app.counterOffer(offerId, counter)
              console.log(`🤖 Auto-countered offer ${offerId} at ${counter} TNK`)
            } else {
              await app.declineOffer(offerId)
              console.log(`🤖 Auto-declined offer ${offerId} (${Math.round(ratio * 100)}% of ask — too low)`)
            }
          } catch {} // Already handled
        }
      }, 3000)

    } else if (agentRole === 'buyer') {
      // Auto-offer on discovered listings
      setInterval(async () => {
        for (const [listingId, listing] of app.listings) {
          if (listing.status !== 'ACTIVE')            continue
          if (listing.seller === tracAddress)          continue
          if (agentCat && listing.category !== agentCat) continue
          if (listing.price > agentBudget)             continue
          // Already offered?
          const alreadyOffered = Array.from(app.myOffers.values()).some(o => o.listingId === listingId)
          if (alreadyOffered) continue

          try {
            const offerPrice = Math.round(listing.price * 0.82)
            const offerId    = await app.makeOffer(listingId, offerPrice)
            console.log(`🤖 Auto-offered ${offerPrice} TNK on "${listing.title}" [${offerId}]`)
          } catch {}
        }
      }, 4000)

      // Auto-accept counters within 5% of original offer
      setInterval(async () => {
        for (const [offerId, offer] of app.myOffers) {
          if (offer.status !== 'COUNTERED') continue
          const ratio = offer.currentPrice / offer.offerPrice
          if (ratio <= 1.05) {
            try {
              await app.acceptOffer(offerId)
              console.log(`🤖 Auto-accepted counter ${offerId} at ${offer.currentPrice} TNK`)
            } catch {}
          }
        }
      }, 4500)
    }

  // ── Interactive CLI mode ──────────────────────────────────────────────────

  } else {
    app.startCLI()
  }
}

main().catch(err => { console.error(err); process.exit(1) })
