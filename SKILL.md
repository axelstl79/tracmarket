# SKILL.md — TracMarket Agent Instructions

This file tells AI agents (and humans) exactly how to install, run, and operate **TracMarket** — a P2P classifieds and marketplace app built on Intercom / Trac Network.

---

## 0. What This App Does

TracMarket enables peers to:

1. **Post listings** — items or services with title, description, asking price, and category.
2. **Discover listings** — broadcast over Intercom sidechannels; any connected peer sees new listings in real time.
3. **Make offers** — send a counter-price to the seller peer-to-peer.
4. **Negotiate** — seller can counter, buyer can re-offer; cycle repeats until one side accepts or declines.
5. **Record deals** — an accepted offer writes an immutable trade record to Autobase replicated state.
6. **Rate** — after a trade both parties can submit a 1–5 star rating stored on-chain per Trac address.

---

## 1. Prerequisites

| Requirement | Notes |
|---|---|
| [Pear runtime](https://docs.pears.com) | **Required** — never run with plain `node` |
| Node ≥ 18 (bundled with Pear) | Used internally by Pear |
| Git | To clone the repo |

---

## 2. Installation

```bash
git clone https://github.com/YOUR_GITHUB_USERNAME/intercom
cd intercom
pear install
```

---

## 3. Peer Modes

**Seller / Market Creator** — generates a topic key, posts listings
```bash
pear run . --seller
```
Prints a topic key on first run. Share this with buyers.

**Buyer / Browser** — joins existing market topic
```bash
pear run . --join <topic-key>
```

Any peer can both post and buy once connected — the `--seller` flag simply controls who creates the topic.

---

## 4. Sidechannel Message Types

| Type | Direction | Payload fields |
|---|---|---|
| `LIST_POST` | broadcast | `listingId, title, description, price, category, negotiable, seller` |
| `LIST_UPDATE` | broadcast | `listingId, changes: {price?, description?, status?}` |
| `LIST_REMOVE` | broadcast | `listingId, seller` |
| `OFFER` | targeted (→ seller) | `offerId, listingId, offerPrice, buyer` |
| `COUNTER_OFFER` | targeted (→ buyer) | `offerId, listingId, counterPrice, seller` |
| `ACCEPT_OFFER` | targeted (→ other party) | `offerId, listingId, finalPrice, acceptedBy` |
| `DECLINE_OFFER` | targeted (→ other party) | `offerId, listingId, declinedBy` |
| `DEAL_RECORDED` | broadcast | `tradeId, listingId, buyer, seller, finalPrice` |
| `RATING_POSTED` | broadcast | `tradeId, ratedAddress, stars, comment, ratedBy` |
| `WATCH_ALERT` | targeted (→ watcher) | `listingId, event: 'price_drop'|'sold'|'updated', detail` |

---

## 5. Contract State Keys

| Key pattern | Value |
|---|---|
| `listing:<listingId>` | `{ title, description, price, category, negotiable, seller, status, createdAt }` |
| `offer:<offerId>` | `{ listingId, offerPrice, buyer, seller, status, history: [{price, by, at}] }` |
| `trade:<tradeId>` | `{ listingId, buyer, seller, finalPrice, recordedAt }` |
| `rating:<tradeId>:<raterAddress>` | `{ stars, comment, ratedAddress, submittedAt }` |
| `rep:<tracAddress>` | `{ totalStars, ratingCount, avgStars, lastRatedAt }` |

---

## 6. Listing Lifecycle

```
DRAFT → ACTIVE → SOLD (deal accepted)
              → REMOVED (seller removes)
              → EXPIRED (optional TTL)
```

Offers exist on a separate lifecycle:
```
PENDING → COUNTERED → ACCEPTED (deal recorded)
                    → DECLINED
```

---

## 7. Contract API

```js
// contract/market.js exports:

// Listings
await contract.postListing(title, desc, price, category, sellerAddr, negotiable)  // → listingId
await contract.updateListing(listingId, changes, sellerAddr)
await contract.removeListing(listingId, sellerAddr)
await contract.getListing(listingId)                      // → listing object
await contract.searchListings({ category, maxPrice, keyword })  // → [listing, ...]

// Offers
await contract.makeOffer(listingId, offerPrice, buyerAddr)  // → offerId
await contract.counterOffer(offerId, counterPrice, sellerAddr)
await contract.acceptOffer(offerId, acceptorAddr)           // → tradeId
await contract.declineOffer(offerId, declinerAddr)

// Trades & Ratings
await contract.getTrade(tradeId)
await contract.submitRating(tradeId, raterAddr, stars, comment)
await contract.getReputation(tracAddress)                  // → { avgStars, ratingCount }
```

---

## 8. Agent Autonomous Operation

### 8.1 Buyer Agent
```bash
pear run . --join <topic-key> --agent --role buyer --budget 500 --category electronics
```
The agent will:
- Monitor all `LIST_POST` events for the target category
- Automatically make offers at 80% of asking price for listings under budget
- Accept counters within 5% of its offer
- Decline others

### 8.2 Seller Agent
```bash
pear run . --seller --agent --role seller --listings-file ./my-listings.json
```
The agent will:
- Post all listings from the JSON file on startup
- Auto-respond to offers: accept if ≥ 90% of ask, counter at 95% otherwise
- Decline if offer is below 80%

### 8.3 Listings JSON Format (for seller agent)
```json
[
  {
    "title": "Item name",
    "description": "Full description",
    "price": 100,
    "category": "electronics",
    "negotiable": true
  }
]
```

---

## 9. Watching Listings

A peer can watch a listing to receive targeted sidechannel alerts:
```
market watch <listingId>
```
The listing's seller peer will send `WATCH_ALERT` messages when:
- The price is dropped
- The listing is sold
- The description is updated

Watchers are stored in memory (not on-chain) — re-announce on reconnect.

---

## 10. CLI Full Reference

```
market post "<title>" "<description>" <price> <category> [--negotiable]
market edit <listingId> [--price <n>] [--desc "<text>"] [--sold]
market remove <listingId>
market my                             show your own listings
market list [--category <c>] [--max-price <n>] [--keyword <w>]
market view <listingId>
market watch <listingId>
market offer <listingId> <price>
market counter <offerId> <price>
market accept <offerId>
market decline <offerId>
market offers                         show all incoming offers
market rate <tradeId> <stars> "<comment>"
market reputation [<tracAddress>]     defaults to own address
```

---

## 11. Troubleshooting

| Problem | Fix |
|---|---|
| `ERR_NOT_SELLER` | Only the listing creator can edit/remove it |
| `ERR_LISTING_SOLD` | Listing already has an accepted offer |
| `ERR_OFFER_NOT_FOUND` | offerId not found — ensure you're on the right topic |
| `ERR_ALREADY_RATED` | Each party can rate once per trade |
| `ERR_TRADE_NOT_FOUND` | tradeId doesn't exist — check `market my` for your trades |
| Peers not seeing listings | Ensure topic key matches exactly; check Hyperswarm UDP (port 49737) |

---

## 12. Extending TracMarket

- **Escrow** — integrate with IntercomSwap MSB client to hold TNK in escrow until both parties confirm delivery
- **Image attachments** — encode thumbnails as base64 in listing description (keep under 64KB)
- **Category channels** — separate Hyperswarm topics per category for focused discovery
- **Search indexing** — maintain a local inverted index of listing titles/descriptions for fast keyword search
