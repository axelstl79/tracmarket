# TracMarket 🏪

**P2P classifieds & decentralized marketplace on Trac Network via Intercom**

TracMarket is a fork of [Intercom](https://github.com/Trac-Systems/intercom) that turns the Intercom stack into a serverless peer-to-peer classifieds board. Sellers post listings for items or services; buyers browse, make offers, and negotiate — all over Intercom sidechannels. Agreed deals are committed to Autobase replicated state as an immutable trade record.

No central server. No platform fees. No accounts. Just peers.

---

## Features

- **Post listings** — items or services with title, description, price, and category
- **Browse & search** — filter by category, keyword, or price range across all peer-announced listings
- **Make offers** — send a counter-price to a seller over a private sidechannel
- **Negotiate** — back-and-forth offer/counter-offer flow, fully P2P
- **Accept deals** — accepted trades are written immutably to Autobase as a verifiable record
- **Rate peers** — leave a 1–5 star rating after a completed trade (reputation on-chain)
- **Watch listings** — get notified when a listing you're watching is updated or price-dropped
- **Agent-ready** — full SKILL.md for AI agents to browse, post, and negotiate autonomously

---

## How It Works

```
Seller Peer                              Buyer Peer
    |                                         |
    |-- LIST_POST (sidechannel broadcast) --> |
    |   title, price, category, listingId     |
    |                                         |-- OFFER (sidechannel → seller)
    |                                         |   { listingId, offerPrice, buyer }
    |<-- COUNTER_OFFER or ACCEPT_OFFER -------|
    |                                         |
    |-- ACCEPT_OFFER -----------------------> |
    |                                         |
    Both: contract.recordDeal(listingId, buyer, finalPrice)
          → immutable trade record on Autobase
    Both: contract.submitRating(tradeId, stars, comment)
```

Listings are broadcast over sidechannels so any connected peer discovers them immediately. Offers and negotiations happen in targeted peer-to-peer messages. The final accepted price and trade record are written to the replicated Autobase state — visible to all, owned by no one.

---

## Quick Start

> **Requires [Pear runtime](https://docs.pears.com).** Never use plain `node`.

```bash
# Clone your fork
git clone https://github.com/YOUR_GITHUB_USERNAME/intercom
cd intercom
pear install

# Start as a seller (creates the market topic)
pear run . --seller

# Join as a buyer (or seller who also wants to browse)
pear run . --join <topic-key>
```

---

## CLI Commands

### Listing Management
```
market post "<title>" "<description>" <price> <category> [--negotiable]
market edit <listingId> [--price <n>] [--desc "<text>"] [--sold]
market remove <listingId>
market my
```

### Browsing
```
market list [--category <cat>] [--max-price <n>] [--keyword <word>]
market view <listingId>
market watch <listingId>
```

### Offers & Negotiation
```
market offer <listingId> <offerPrice>
market counter <offerId> <counterPrice>
market accept <offerId>
market decline <offerId>
market offers                          (show incoming offers on your listings)
```

### Reputation
```
market rate <tradeId> <stars 1-5> "<comment>"
market reputation <tracAddress>
```

---

## Example Session

```
── Seller ──────────────────────────────────────────────────────────────────────

> market post "Vintage Mechanical Keyboard" "Cherry MX Blue, 80%, mint condition" 120 electronics --negotiable
✓ Listing posted: lst_a1b2c3  Price: 120 TNK  Category: electronics
  Announced to 4 peers.

> market offers
  off_x9y8z7  lst_a1b2c3  "Vintage Mechanical Keyboard"
              Offer: 90 TNK from buyer7f2d…
              [accept / counter / decline]

> market counter off_x9y8z7 105
✓ Counter-offer sent: 105 TNK

> market accept off_x9y8z7
✓ Deal accepted! Trade recorded on-chain.
  Trade ID: trd_44f5e6  Price: 105 TNK
  Buyer: buyer7f2d…


── Buyer ────────────────────────────────────────────────────────────────────────

📢 New listing from seller9a1b… [lst_a1b2c3] electronics — 120 TNK
   "Vintage Mechanical Keyboard" — Cherry MX Blue, 80%, mint condition
   💬 Negotiable

> market offer lst_a1b2c3 90
✓ Offer sent: 90 TNK on lst_a1b2c3

📩 Counter-offer on lst_a1b2c3: 105 TNK from seller9a1b…

> market accept off_x9y8z7
✓ Deal accepted! Trade ID: trd_44f5e6
  Price: 105 TNK

> market rate trd_44f5e6 5 "Fast response, item exactly as described."
✓ Rating submitted. seller9a1b… reputation updated.
```

---

## Categories

`electronics` · `collectibles` · `clothing` · `books` · `services` · `real-estate` · `vehicles` · `other`

---

## Reputation System

Ratings (1–5 stars) are stored per Trac address in Autobase. Each completed trade produces one rating slot — buyers rate sellers and sellers rate buyers. The on-chain reputation score is a simple weighted average, visible to any peer via `market reputation <address>`.

---

## Project Structure

```
.
├── index.js                 # Pear entry point
├── contract/
│   └── market.js            # Listings, offers, trades, ratings contract
├── features/
│   └── market-cli.js        # CLI + sidechannel integration
├── SKILL.md                 # Agent-oriented instructions
├── package.json
└── README.md
```

---

## Trac Address

> **Reward address:** `YOUR_TRAC_ADDRESS_HERE`
> *(Replace with your actual Trac address before submitting)*

---

## License

MIT — fork freely.
