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

## ✅ Phase 3 — Complete

### 1. Tavily web search in scan-events.js ✓
Two-tier approach — no AI credits needed:
- Tier 1 (VERIFY_EVENTS): targeted searches for 8 known high-impact events (Gulf Coast Jam,
  Thunder Beach, Barrett-Jackson, WM Phoenix Open, Country Thunder AZ, Smoky Mtn Songwriters).
  Regex-based date extraction from Tavily results — zero API credits.
- Tier 2 (DISCOVERY_SEARCHES): broad market searches with keyword impact scoring.
- TAVILY_API_KEY added to GitHub Actions secrets ✓

### 2. Populate pricing_snapshots table ✓
- snapshotPriceLabsData() added to daily-report/index.js
- Upserts 4 properties × 91 days = 364 rows every morning after plData is fetched
- Upserts on unique (property_id, date) constraint — safe to re-run
- Skipped in preview mode, fails gracefully without blocking email send
- First run: 364 rows captured 2026-06-02 ✓

### 3. Tier 2 — Push pricing changes to PriceLabs from Owner Portal 🔴 UP NEXT
Allow approving/dismissing pricing recommendations from the Owner Portal instead of
manually opening PriceLabs each time.

**Step 1 — New Supabase table `pricing_actions`:**
```sql
CREATE TABLE pricing_actions (
  id                    serial PRIMARY KEY,
  property_id           integer NOT NULL,
  pricelabs_listing_id  text NOT NULL,
  window_label          text NOT NULL,  -- e.g. "Days 31–60 (Jun 26–Jul 25)"
  current_avg_price     numeric,
  recommended_base_price numeric,
  market_median         numeric,
  reason                text,           -- full "because" explanation text
  status                text DEFAULT 'pending',  -- pending / applied / dismissed
  created_at            timestamptz DEFAULT now(),
  resolved_at           timestamptz
);
```

**Step 2 — daily-report/index.js changes:**
- After computePropertyAlerts(), write RED/YELLOW alerts to pricing_actions with status='pending'
- Skip if a pending action already exists for same property_id + window_label today
- recommended_base_price: use alertData[prop.plId].settings.base as the current base,
  suggest reducing by ~10% for YELLOW, ~15-20% for RED

**Step 3 — Owner Portal (repo: picture-perfect-stays-portal, local: C:\Users\crhan\Projects\picture-perfect-stays-portal):**
- New page: /actions — lists pending pricing_actions with full reason text
- Apply button → calls /api/apply-pricing-action
- Dismiss button → marks action dismissed in Supabase
- New API route: /api/apply-pricing-action
  - Authenticated
  - Reads pricing_action from Supabase
  - Calls PriceLabs POST /v1/listings: { listings: [{ id, pms: 'ownerrez', base: recommended_base_price }] }
  - Marks action as applied in Supabase (status='applied', resolved_at=now())

Note: PriceLabs API updates base price for the whole listing (not date-range specific).
"Reduce days 31-60" becomes "reduce base price" — PriceLabs recalculates from there.

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
- Depends on: pricing_snapshots populated (Phase 3 ✓), Owner Portal auth upgrade

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
- Depends on: pricing_snapshots table being populated (Phase 3 ✓)

### 9. Invoice / Stripe integration
Generate and send owner invoices automatically.

### 10. Client onboarding workflow
Automate onboarding of new property owners.
