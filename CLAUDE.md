# Picture Perfect Stays — Revenue Management System
## Claude Code Context File — loads automatically every session

---

## Who I am
Chris Hanson — owner of Picture Perfect Stays, a short-term rental co-hosting company.
Email: chris@staypictureperfect.com | Timezone: Arizona (MST, no DST)

---

## My 4 Properties

| Property | OwnerRez ID | Supabase ID | Location | Type | Beds/Baths | PL Min Price |
|----------|-------------|-------------|----------|------|------------|--------------|
| Emerald Views | 471179 | 5 | Panama City Beach, FL | Condo | 1BR/2BA sleeps 6 | $105 |
| Enchanted Getaway | 471178 | 6 | Sevierville, TN | Cabin | 3BR/2BA sleeps 8 | none |
| Musical Oasis | 471181 | 7 | Scottsdale, AZ | Condo | 1BR/1BA sleeps 4 | $90 |
| Travelers Paradise | 471180 | 8 | Scottsdale, AZ | Condo | 1BR/1BA sleeps 4 | $100 |

**Notes:**
- PriceLabs pms name: `ownerrez` (required in all API calls)
- Enchanted Getaway is listed as 3BR on OTAs but is actually 2BR + open loft
- Both Scottsdale properties are in the same complex at 7625 E Camelback Rd

---

## Seasonality
- **Panama City Beach (Emerald Views):** Peak = June–Aug + spring break (March). Slow = mid-Sept to mid-March
- **Sevierville TN (Enchanted Getaway):** Peak = summer + fall foliage. Slower = Jan–Feb
- **Scottsdale (Musical Oasis, Travelers Paradise):** Peak = Oct–April. Slow = May–Sept (extreme heat)

---

## Infrastructure

### Supabase (primary data store)
- URL: `https://vzozyzkaovegwfdmbcxg.supabase.co`
- Credentials: `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` in `~/.claude/settings.json`
- Key tables: `bookings`, `properties`, `property_owners`, `owners`, `booking_charges`, `pricing_snapshots`, `market_data_cache`, `seasonal_price_floors`
- Booking sync: runs every 3 hours via pg_cron → Edge Function `sync-bookings`
- 1,301 bookings loaded, going back to June 2019

### Supabase REST API pattern
```javascript
const url = process.env.SUPABASE_URL;  // or read from settings.json
const key = process.env.SUPABASE_SERVICE_KEY;
const headers = { 'apikey': key, 'Authorization': 'Bearer ' + key };

// Read bookings
fetch(url + '/rest/v1/bookings?property_id=in.(5,6,7,8)&status=eq.active&select=...', { headers })

// Paginate (Supabase caps at 1000 rows)
fetch(url + '/rest/v1/bookings?...&limit=1000&offset=0', { headers })
```

### PriceLabs MCP (connected in Claude Code)
- Tools: `list_listings`, `get_prices`, `get_portfolio_prices`, `get_listing_settings`, `update_listing_settings`, `get_reservation_data`, `get_market_data`
- PriceLabs API base: `https://api.pricelabs.co/v1`
- Auth header: `X-API-Key: {PRICELABS_API_KEY from settings.json}`

### PriceLabs API patterns (for remote routines)
```
POST /v1/listing_prices
body: { listings: [{ id: "471179", pms: "ownerrez", dateFrom: "YYYY-MM-DD", dateTo: "YYYY-MM-DD" }] }

GET /v1/neighborhood_data?pms=ownerrez&listing_id=471179
→ returns 25th/50th/75th/90th percentile pricing by date

POST /v1/listings
body: { listings: [{ id: "471179", pms: "ownerrez", min: 105, base: 228 }] }
→ update pricing settings
```

### OwnerRez MCP (connected in Claude Code)
- Tools: `get_properties`, `get_bookings`, `get_booking_detail`, `get_guests`, `get_revenue_summary`
- Note: LOCAL only — not available to remote CoWork routines. Use Supabase for booking data in routines.

### Owner Portal
- Repo: `github.com/pictureperfectstays/picture-perfect-stays-portal` (private)
- Deployed on Vercel, reads from Supabase
- Local clone: `C:\Users\crhan\Projects\picture-perfect-stays-portal`

---

## Revenue Management Philosophy
- **Never price blind** — always check market percentile data before recommending price changes
- **Gap nights** — proactively offer discounted nights between bookings to adjacent guests
- **Market position** — Emerald Views targets 75th–90th percentile (premium 1BR with 2BA)
- **Scottsdale summer** — needs aggressive min stays and extended stay discounts
- **Cancellation pattern** — Emerald Views has high cancellation rate, watch closely

---

## Key Revenue Questions I ask regularly
- What are my open nights in the next 30/60/90 days and how are they priced vs market?
- What is my booking window for [property] this year vs last year?
- Which properties have gap nights that need outreach?
- How does my ADR compare to market percentiles for [property]?
- What is my cancellation rate for [property] this year?
- Which booking channel produces the highest ADR?
- Should I raise, lower, or hold prices for [property] over [date range]?

---

## GitHub repos
- Owner Portal: `github.com/pictureperfectstays/picture-perfect-stays-portal` (private)
- Revenue Estimator: `github.com/pictureperfectstays/pictureperfectstays-revenue` (private)
- Automation scripts: `github.com/pictureperfectstays/pps-automation` (**public** — daily report, future automation)

---

## Channel Markups & Fees (critical for gap discount math)
- **Airbnb:** 18.34% markup in OwnerRez, 15.5% host-only fee → net ≈ PriceLabs price (cancel out by design)
- **VRBO:** 10% markup, 8% fee (5% VRBO + 3% payment processing)
- **Booking.com:** 30% markup, 18% fee
- **Direct:** 0% markup, 0% fee
- Gap discount base = OwnerRez `charges_json` rent / nights (= PriceLabs net target, markup not in charges_json)
- Gap discount formula: discounted_rent = base × (1 - pct), guest_pays = discounted_rent × (1 + tax_rate), your_net = discounted_rent × (1 - channel_fee)

## Tax Rates (in Supabase `tax_rules` table, loaded at runtime)
- Panama City Beach, FL (Prop 5): 13% total (Bay County 5% + PCB 1% + FL State 7%)
- Sevierville, TN (Prop 6): 12.75% total (Sevier County 3% + TN State 9.75%)
- Scottsdale, AZ (Props 7 & 8): 13.97% total (Maricopa County 7.27% + City Hotel/Motel 5% + City Hotels 1.70%)
- Note: FL state 7% is remitted by Airbnb directly; OwnerRez only tracks 6% for PCB

## PriceLabs API Key
- In `~/.claude/settings.json` as `PRICELABS_API_KEY`
- Also in `C:\Users\crhan\AppData\Roaming\Claude\claude_desktop_config.json` (used by MCP)
- Note: PriceLabs returns `LISTING_NO_DATA` during overnight recalculation (~11pm–6am AZ). Normal at 7am send time.

---

## What's built vs planned
**Built:**
- Supabase schema + booking sync (every 3 hours)
- Owner Portal (Vercel, reads Supabase, tax reporting from `tax_rules` table)
- PriceLabs + OwnerRez MCPs
- `tax_rules` table populated for all 3 markets
- **Daily revenue email report (Phase 1 COMPLETE)** — `daily-report/index.js`
  - Sends from `reports@mail.staypictureperfect.com` via Resend
  - Sections: MTD revenue YoY, 24h activity, open nights + gap discount tables, PriceLabs pricing
  - CoWork routine scheduled: `trig_01ErnBxPftR8ZJN2r9j4o9JQ`, cron `0 14 * * *` (7am AZ)
  - Logo + Instagram icon hosted on Supabase Storage (`assets` bucket)
  - **Routine test pending** — remote Node.js availability unconfirmed; local `node index.js` works perfectly

**Phase 2 (next session — revenue management intelligence):**
- Priority Action Board at top of email (Claude writes plain-English briefing with specific $ recommendations)
- Booking pace vs last year (ahead/behind per property)
- Revenue forecast (projected month-end based on pace + historical fill rates)
- Smart event detection (Cardinals games, spring break, foliage) calibrated to actual historical ADR — don't blindly follow PriceLabs on events

**Also planned:** Seasonal price floor automation, Owner Portal auth upgrade (magic link), Invoice/Stripe, Revenue estimator, Client onboarding
