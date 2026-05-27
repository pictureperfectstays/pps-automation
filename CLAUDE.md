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
- **Daily revenue email report (COMPLETE)** — `daily-report/index.js`
  - Sends from `reports@mail.staypictureperfect.com` via Resend
  - Logo + Instagram icon hosted on Supabase Storage (`assets` bucket)
  - GitHub Actions workflows created (`.github/workflows/`): `daily-report.yml` (7am AZ) + `scan-events.yml` (Mon/Thu 5am AZ)
  - **Secrets still need adding to GitHub repo** (see below)
- **Pricing Alerts (COMPLETE)** — proactive RED/YELLOW per property × 3 windows
  - Uses `price` field only (final channel price, not user_price/uncustomized_price)
  - Neighborhood data category = bedroom count key; Y_values for Occ is double-nested (Y_values[0][0])
  - 61-90 day market occ intentionally null (advance-booking bias makes it unreliable)
  - Actions are directive: "Reduce prices in PriceLabs..." not "Monitor..."
- **Booking Pace vs Last Year (COMPLETE)** — 3 months, revenue + nights on books today vs same date LY
  - Uses `booked_at` NOT `created_at`; revenue prorated across month boundaries
  - Include current month if >= 7 days remain; otherwise show next 3 full months
- **Revenue Forecast (COMPLETE)** — projected month-end per property × 3 months
  - Fill rate = % of historically open nights (at same calendar point) that filled by month-end
  - Uses ALL available history back to first booking per property (not just 2 years)
  - Scenarios: Conservative 0.5×, Base 1.0×, Optimistic 1.3× fill rate
  - Portfolio total shows partial scenarios with "excl. [PropName]" note for new/data-sparse properties
  - Emerald Views: purchased June 2025, first booking June 26 2025 — May has no LY data (correct)
- **Smart Event Detection (COMPLETE)** — `daily-report/events-calendar.js` + `daily-report/scan-events.js`
  - 40+ hardcoded recurring events across all 3 markets (see events-calendar.js)
  - Thunder Beach Rally dates computed algorithmically (last Thu–Sun of April/October)
  - Ticketmaster Discovery API (key: `TICKETMASTER_API_KEY` in settings.json) — Mon/Thu scan
  - ESPN API for sports: Cardinals NFL (team 22), ASU football (team 9), Tennessee football + basketball (team 2633)
  - Events cache: `daily-report/events-cache.json` — local file, committed to repo by scan workflow
  - Filtering: football skipped from TM (ESPN handles), MLB regular season skipped, NBA regular season skipped, music/arts require major venue or 5,000+ capacity
  - Arena venues (Footprint Center, State Farm Stadium, Chase Field, etc.) = HIGH impact regardless of reported capacity
  - Alert email fires immediately for HIGH/VERY-HIGH impact newly discovered events only
  - Report table: shows hardcoded + ESPN events at all impact levels; TM events only if HIGH/VERY-HIGH
  - 91–120 day lookahead: informational only, no ADR comparison (no PriceLabs data that far out)
  - NEW badge on events discovered within last 7 days
  - Historical ADR: prorated from `histActive` bookings on same dates in prior years
- **Priority Action Board (COMPLETE)** — rule-based full-report action summary at top of email
  - No AI API needed — pure JavaScript, always runs
  - Aggregates ALL actionable items from every section, ranked by priority:
    1. RED pricing alerts | 2. Cancellations (24h) | 3. Gap nights + HIGH events ≤30d
    4. YELLOW pricing alerts | 5. HIGH events 31-60d + no booking >21d with open nights
    6. Booking pace >20% behind LY | 7. MTD portfolio >15% behind LY
  - Data: reuses plData, alertData, bookings, events; adds MAX(booked_at) Supabase query per property
  - Each item has a color-coded badge, specific dollar amounts (bolded), and a "↓ Jump" anchor link
  - All 8 section h2 tags have `id` attributes for in-email anchor navigation (Gmail desktop supported)
  - Shows "✓ No actions needed" when all properties are on track
  - Rendered as light-blue card (`#eef4fb`) with brand-blue left border, above all white sections
  - `loadEnv()` now merges both `~/.claude/settings.json` AND `daily-report/settings.json`

## Current email section order
0. Priority Action Board (AI briefing — above everything else)
1. Month-to-Date Revenue
2. Activity — Last 24 Hours
3. Pricing Alerts
4. Smart Event Detection
5. Open Nights & Gap Opportunities
6. Booking Pace vs Last Year
7. Revenue Forecast
8. Pricing — Open Days (Next 90)

## GitHub Actions secrets needed (not yet added)
Go to repo Settings → Secrets → Actions → New repository secret:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY`
- `RESEND_API_KEY`
- `PRICELABS_API_KEY`
- `TICKETMASTER_API_KEY`
- `ANTHROPIC_API_KEY`

## Next sessions — work remaining

**To activate Priority Action Board:** add `ANTHROPIC_API_KEY` to `~/.claude/settings.json` under `env`, and add as a GitHub Actions secret (see secrets list above).

**Also needed — Owner Revenue Report**
- Property-specific report (one per owner, showing only their property's data)
- Owner-friendly framing — not operator jargon (no gap discount math, no PriceLabs internals)
- Show: revenue this month + YoY, upcoming bookings, occupancy, seasonal context
- Linked from the Owner Portal (`github.com/pictureperfectstays/picture-perfect-stays-portal`)
- Owner Portal local clone: `C:\Users\crhan\Projects\picture-perfect-stays-portal`
- Delivered as a page in the portal (always current), not an email

**Also planned:** Seasonal price floor automation, Owner Portal auth upgrade (magic link), Invoice/Stripe, Revenue estimator, Client onboarding
