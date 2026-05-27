# Picture Perfect Stays — Task List
Last updated: 2026-05-23

---

## 🔴 In Progress

### 1. Redesign Action Board (daily report)
Rebuild the top-of-email summary as per-property cards instead of a flat category list.
- Per-property layout with status indicator (🔴 🟡 🟢) + legend
- One synopsis line per property (occupancy vs market, revenue trend, last booking)
- Max 2-3 action items per property, with "because" language built into each one
- Gap nights: only next 14 days, max one per property
- Events: only HIGH/VERY-HIGH in next 30 days, attached to relevant property
- Portfolio note at bottom if MTD/pace is materially off

---

## 🟡 Up Next (in priority order)

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
Allow approving/dismissing pricing recommendations from a portal page instead of manually opening PriceLabs.

**Daily report changes:**
- Write RED/YELLOW pricing alerts to new Supabase `pricing_actions` table (status = 'pending')
- Don't duplicate — skip if a pending action already exists for same property+window today

**Supabase changes:**
- New table: `pricing_actions` (id, property_id, pricelabs_listing_id, window_label,
  current_avg_price, recommended_base_price, market_median, reason, status, created_at, resolved_at)

**Owner Portal changes (repo: picture-perfect-stays-portal):**
- New page: `/actions` — lists pending pricing recommendations with full reason
- Apply button → calls `/api/apply-pricing-action`
- Dismiss button → marks action dismissed in Supabase
- New API route: `/api/apply-pricing-action` — authenticated, calls PriceLabs
  `POST /v1/listings` to update base price, marks action applied

Note: PriceLabs API updates base price for the whole listing (not date-range specific).
"Reduce days 31-60" becomes "reduce base price" — PriceLabs recalculates from there.

### 4. GitHub Actions secrets
All secrets still need to be added to the GitHub repo before the 7am workflow runs.
Go to: repo Settings → Secrets and variables → Actions → New repository secret
- SUPABASE_URL
- SUPABASE_SERVICE_KEY
- RESEND_API_KEY
- PRICELABS_API_KEY
- TICKETMASTER_API_KEY
- ANTHROPIC_API_KEY

---

## 🔵 Planned (not yet scheduled)

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

### 8. Revenue Estimator
Estimate expected revenue for future months based on historical data.
- Depends on: pricing_snapshots table being populated (task 2)

### 9. Invoice / Stripe integration
Generate and send owner invoices automatically.

### 10. Client onboarding workflow
Automate onboarding of new property owners.
