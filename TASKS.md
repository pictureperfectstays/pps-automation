# Picture Perfect Stays — Task List
Last updated: 2026-06-02

---

## ✅ Phase 1 & 2 — Complete

- Daily revenue email report (7am AZ via GitHub Actions) ✓
- Per-property Action Board with 🔴🟡🟢 status, "because" explanations, jump links ✓
- Pricing alerts (open nights only, actual date ranges, open nights count) ✓
- Smart event detection (Ticketmaster, ESPN, algorithmic Gulf Coast Jam / Thunder Beach) ✓
- Gap night outreach with guest names and dollar amounts ✓
- Booking pace, revenue forecast, MTD revenue, pricing open days ✓
- Min prices live from PriceLabs API ✓
- Dynamic booking pace note (auto-updates by season and property age) ✓
- GitHub Actions workflows live (Node.js 24, all secrets added) ✓

---

## 🔴 Phase 3 — In Progress

### 1. Tavily web search in scan-events.js
Add automated web searching for events not found on Ticketmaster — runs inside the
existing Mon/Thu scan-events workflow alongside Ticketmaster and ESPN.
- Sign up at tavily.com ✓
- Add TAVILY_API_KEY to ~/.claude/settings.json ✓
- Add TAVILY_API_KEY to GitHub Actions secrets (TODO)
- Add `webSearchEvents(market, year)` function to scan-events.js
- Use Claude API to parse results into event name/dates/impact
- Store results in events-cache.json alongside Ticketmaster events

### 2. Populate pricing_snapshots table
The `pricing_snapshots` Supabase table has been empty since creation.
The daily report already fetches plData (4 properties × 90 days from PriceLabs).
Add a upsert step that writes this data to `pricing_snapshots` each morning.
- Add `snapshotPriceLabsData(plData, todayStr)` function to daily-report/index.js
- Upsert on (property_id, date) — captures daily snapshot of PriceLabs recommendations
- Leave `adr` column null for now (filled later from actual bookings)
- Batch in chunks of 500 rows to stay under Supabase payload limits
- Only runs if PRICELABS_KEY and plData are available

### 3. Tier 2 — Push pricing changes to PriceLabs from Owner Portal
Allow approving/dismissing pricing recommendations from a portal page instead of
manually opening PriceLabs.

**Daily report changes:**
- Write RED/YELLOW pricing alerts to new Supabase `pricing_actions` table (pending)
- Don't duplicate — skip if pending action already exists for same property+window today

**Supabase changes:**
- New table: `pricing_actions` (id, property_id, pricelabs_listing_id, window_label,
  current_avg_price, recommended_base_price, market_median, reason, status,
  created_at, resolved_at)

**Owner Portal changes (repo: picture-perfect-stays-portal):**
- New page: `/actions` — lists pending pricing recommendations with full reason
- Apply button → calls `/api/apply-pricing-action`
- Dismiss button → marks action dismissed in Supabase
- New API route: `/api/apply-pricing-action` — authenticated, calls PriceLabs
  `POST /v1/listings` to update base price, marks action applied

Note: PriceLabs API updates base price for the whole listing (not date-range specific).

---

## 🟡 Phase 4 — Up Next

### 4. Operations Manual (Word document)
Write a full O&M manual for the daily revenue report — to be done once Phase 3 is complete.
- Cover page with Picture Perfect Stays logo and company info
- Auto-generated table of contents
- One section per report section explaining how it works and how to act on it
- Technical reference appendix (GitHub Actions schedule, secrets, manual re-run, troubleshooting)
- Delivered as .docx (Chris can PDF it to share)

### 5. Owner Revenue Report (Owner Portal)
Property-specific report page in the portal — one per owner, showing only their property.
- Revenue this month + YoY, upcoming bookings, occupancy, seasonal context
- Owner-friendly framing (no PriceLabs internals, no gap discount math)
- Delivered as a portal page (always current), not an email
- Depends on: pricing_snapshots populated (task 2), Owner Portal auth upgrade

### 6. Owner Portal auth upgrade
Upgrade from current auth to magic link (email-based, no password).

### 7. Seasonal price floor automation
Auto-update PriceLabs minimum prices based on season.
- Uses `seasonal_price_floors` table in Supabase
- Runs on a schedule or triggered from the portal

---

## 🔵 Phase 5 — Planned

### 8. Revenue Estimator
Estimate expected revenue for future months based on historical data.
- Depends on: pricing_snapshots table being populated (Phase 3, task 2)

### 9. Invoice / Stripe integration
Generate and send owner invoices automatically.

### 10. Client onboarding workflow
Automate onboarding of new property owners.
