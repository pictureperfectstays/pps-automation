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
- Owner Portal: `github.com/pictureperfectstays/picture-perfect-stays-portal`
- Revenue Estimator: `github.com/pictureperfectstays/pictureperfectstays-revenue`
- Both are private — need GitHub Personal Access Token to read via API

---

## What's built vs planned
**Built:** Supabase schema, booking sync, Owner Portal (Supabase-powered), PriceLabs + OwnerRez MCPs, price floors on Scottsdale properties
**In progress:** Daily revenue email report (Phase 1)
**Planned:** Seasonal price floor automation, Owner Portal auth upgrade (magic link), Invoice/Stripe, Revenue estimator, Client onboarding
