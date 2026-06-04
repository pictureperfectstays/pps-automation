#!/usr/bin/env node
// Daily Revenue Report — Picture Perfect Stays
// Run: node index.js
// Required env: SUPABASE_URL, SUPABASE_SERVICE_KEY, RESEND_API_KEY
// Optional env: PRICELABS_API_KEY (enables pricing section — key in ~/.claude/settings.json)

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { getHardcodedEvents, PROP_MARKET } from './events-calendar.js';
const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Credentials ─────────────────────────────────────────────────────────────

function loadEnv() {
  const env = { ...process.env };
  // Merge both global (~/.claude/settings.json) and local (daily-report/settings.json),
  // with local taking precedence. This way all credentials can live in one place.
  const settingsPaths = [
    join(homedir(), '.claude', 'settings.json'),
    join(__dirname, 'settings.json'),
  ];
  for (const p of settingsPaths) {
    try {
      const settings = JSON.parse(readFileSync(p, 'utf8'));
      if (settings.env) Object.assign(env, settings.env);
    } catch {}
  }
  return env;
}

const ENV = loadEnv();
const SUPABASE_URL = ENV.SUPABASE_URL;
const SUPABASE_KEY = ENV.SUPABASE_SERVICE_KEY;
const RESEND_KEY = ENV.RESEND_API_KEY;
const PRICELABS_KEY = ENV.PRICELABS_API_KEY;
const ANTHROPIC_KEY = ENV.ANTHROPIC_API_KEY;
const PL_DATA_FILE = ENV.PRICELABS_DATA_FILE; // fallback: load from file if set

if (!SUPABASE_URL || !SUPABASE_KEY) { console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY'); process.exit(1); }
if (!RESEND_KEY) { console.error('Missing RESEND_API_KEY'); process.exit(1); }

// ─── Config ──────────────────────────────────────────────────────────────────

const SEND_TO = 'chris@staypictureperfect.com';
const SEND_FROM = 'reports@mail.staypictureperfect.com';
const LOGO_URL = 'https://vzozyzkaovegwfdmbcxg.supabase.co/storage/v1/object/public/assets/logo.png';
const INSTAGRAM_ICON_URL = 'https://vzozyzkaovegwfdmbcxg.supabase.co/storage/v1/object/public/assets/instagram-icon.png';
const WEBSITE_URL = 'https://www.staypictureperfect.com';
const INSTAGRAM_URL = 'https://www.instagram.com/pictureperfectstays';

// targetPct: the market percentile this property targets
// Emerald Views targets p75-p90 (premium 1BR with 2BA)
const PROPERTIES = [
  { id: 5,  plId: '471179', name: 'Emerald Views',      location: 'Panama City Beach, FL', minPrice: 105, targetPct: 75, color: '#668CB3' },
  { id: 6,  plId: '471178', name: 'Enchanted Getaway',  location: 'Sevierville, TN',        minPrice: null, targetPct: 50, color: '#D96666' },
  { id: 7,  plId: '471181', name: 'Musical Oasis',      location: 'Scottsdale, AZ',         minPrice: 90,  targetPct: 50, color: '#737373' },
  { id: 8,  plId: '471180', name: 'Travelers Paradise', location: 'Scottsdale, AZ',         minPrice: 100, targetPct: 50, color: '#65AD89' },
];

// Channel host fees (deducted from your payout)
// Airbnb: 15.5% host-only fee
// VRBO/Vrbo: 5% VRBO fee + 3% payment processing = 8%
// Booking.com: ~18% (confirm exact rate — ranges 15–20%)
// Direct: 0%
const CHANNEL_FEE = {
  'Airbnb':      0.155,
  'Vrbo':        0.08,
  'VRBO':        0.08,
  'HomeAway':    0.08,
  'Booking.com': 0.18,
  'Booking':     0.18,
};
const channelFee = ch => CHANNEL_FEE[ch] || 0;
const channelNet = (price, ch) => Math.round(price * (1 - channelFee(ch)));

// ─── Date Helpers ─────────────────────────────────────────────────────────────

const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const diffDays = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
const today = () => new Date().toISOString().slice(0, 10);
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAYS   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const fmtDate  = d => { const [,m,day] = d.split('-'); return `${MONTHS[+m-1]} ${+day}`; };
const fmtDateL = d => { const dt = new Date(d + 'T00:00:00Z'); return `${DAYS[dt.getUTCDay()]} ${fmtDate(d)}`; };
const isoMonthStart = d => d.slice(0, 7) + '-01';
const fmt$ = n => n == null || n < 0 ? '—' : '$' + Math.round(n).toLocaleString();

// ─── Booking Pace Helpers ─────────────────────────────────────────────────────

// Returns the 3 months to show in the pace section.
// Include current month if >= 7 days remain; otherwise start from next full month.
function getPaceMonths(todayStr) {
  const [yr, mo, day] = todayStr.split('-').map(Number);
  // new Date(yr, mo, 0) = last day of month `mo` (1-indexed, JS handles overflow)
  const daysInMonth   = new Date(yr, mo, 0).getDate();
  const daysRemaining = daysInMonth - day;
  const monthOffset   = daysRemaining >= 7 ? 0 : 1;

  return Array.from({ length: 3 }, (_, i) => {
    const mIdx    = mo - 1 + monthOffset + i; // 0-indexed from Jan
    const tyStart = new Date(Date.UTC(yr,     mIdx,     1));
    const tyEnd   = new Date(Date.UTC(yr,     mIdx + 1, 1));
    const lyStart = new Date(Date.UTC(yr - 1, mIdx,     1));
    const lyEnd   = new Date(Date.UTC(yr - 1, mIdx + 1, 1));
    return {
      start:   tyStart.toISOString().slice(0, 10),
      end:     tyEnd.toISOString().slice(0, 10),
      lyStart: lyStart.toISOString().slice(0, 10),
      lyEnd:   lyEnd.toISOString().slice(0, 10),
      label:   tyStart.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
      lyLabel: lyStart.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
    };
  });
}

// Prorate a booking's gross_revenue and nights into the overlap with [monthStart, monthEnd)
function prorateToMonth(booking, monthStart, monthEnd) {
  const arrival       = booking.arrival_date;
  const departure     = booking.departure_date;
  const totalNights   = booking.nights || Math.max(1, diffDays(arrival, departure));
  const overlapStart  = arrival   < monthStart ? monthStart : arrival;
  const overlapEnd    = departure > monthEnd   ? monthEnd   : departure;
  const overlapNights = diffDays(overlapStart, overlapEnd);
  if (overlapNights <= 0) return { revenue: 0, nights: 0 };
  const frac = overlapNights / totalNights;
  return { revenue: (Number(booking.gross_revenue) || 0) * frac, nights: overlapNights };
}

// ─── Supabase ─────────────────────────────────────────────────────────────────

async function sb(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  return r.json();
}

// ─── Data Fetching ────────────────────────────────────────────────────────────

async function fetchBookings90(fromDate, toDate) {
  return sb(
    `bookings?select=id,property_id,guest_display_name,arrival_date,departure_date,nights,gross_revenue,net_revenue,booking_channel,booked_at,charges_json`
    + `&status=in.(active,blocked)&arrival_date=lt.${toDate}&departure_date=gt.${fromDate}`
    + `&order=arrival_date.asc`
  );
}

// Extract rent-per-night from a booking's charges_json
// This is the OwnerRez base rent (= PriceLabs net target), NOT the marked-up channel price
function rentPerNight(booking) {
  if (!booking) return null;
  const charges = booking.charges_json || [];
  const totalRent = charges.filter(c => c.type === 'rent').reduce((s, c) => s + (c.amount || 0), 0);
  const nights = booking.nights || 1;
  return totalRent > 0 ? totalRent / nights : null;
}

async function fetchRecentActivity() {
  const since = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
  const [newBookings, cancellations] = await Promise.all([
    sb(`bookings?select=id,property_id,guest_display_name,arrival_date,departure_date,nights,gross_revenue,booking_channel,booked_at&status=eq.active&booked_at=gte.${since}&order=booked_at.desc`),
    sb(`bookings?select=id,property_id,guest_display_name,arrival_date,departure_date,nights,gross_revenue,booking_channel,updated_at&status=eq.canceled&updated_at=gte.${since}&order=updated_at.desc`),
  ]);
  return { newBookings, cancellations };
}

async function fetchMTDRevenue(todayStr) {
  const thisStart = isoMonthStart(todayStr);
  const lyToday   = addDays(todayStr, -365);
  const lyStart   = isoMonthStart(lyToday);
  const [cur, ly] = await Promise.all([
    sb(`bookings?select=property_id,gross_revenue,net_revenue,nights&status=eq.active&arrival_date=gte.${thisStart}&arrival_date=lte.${todayStr}`),
    sb(`bookings?select=property_id,gross_revenue,net_revenue,nights&status=eq.active&arrival_date=gte.${lyStart}&arrival_date=lte.${lyToday}`),
  ]);
  return { cur, ly, thisStart, lyStart };
}

async function fetchBookingPaceData(paceMonths, todayStr) {
  // LY snapshot: include all of (today − 365), not just midnight
  const lySnapshot   = addDays(todayStr, -365) + 'T23:59:59';
  const firstTYStart = paceMonths[0].start;
  const lastTYEnd    = paceMonths[paceMonths.length - 1].end;
  const firstLYStart = paceMonths[0].lyStart;
  const lastLYEnd    = paceMonths[paceMonths.length - 1].lyEnd;
  const [tyBookings, lyBookings] = await Promise.all([
    sb(`bookings?select=property_id,arrival_date,departure_date,nights,gross_revenue&status=eq.active&arrival_date=lt.${lastTYEnd}&departure_date=gt.${firstTYStart}&order=arrival_date.asc`),
    sb(`bookings?select=property_id,arrival_date,departure_date,nights,gross_revenue&status=eq.active&booked_at=lte.${lySnapshot}&arrival_date=lt.${lastLYEnd}&departure_date=gt.${firstLYStart}&order=arrival_date.asc`),
  ]);
  return { tyBookings, lyBookings };
}

async function fetchRevenueForecastData(paceMonths, todayStr) {
  const firstStart       = paceMonths[0].start;
  const lastEnd          = paceMonths[paceMonths.length - 1].end;
  const currentYearStart = `${todayStr.slice(0, 4)}-01-01`;

  // Fetch in parallel: current-year blocks for forecast months + all historical active/blocked
  const [tyBlocked, histPage1, histPage2, histBlocked] = await Promise.all([
    sb(`bookings?select=property_id,arrival_date,departure_date&status=eq.blocked&arrival_date=lt.${lastEnd}&departure_date=gt.${firstStart}&order=arrival_date.asc`),
    sb(`bookings?select=property_id,arrival_date,departure_date,gross_revenue,booked_at&status=eq.active&arrival_date=lt.${currentYearStart}&order=arrival_date.asc&limit=1000&offset=0`),
    sb(`bookings?select=property_id,arrival_date,departure_date,gross_revenue,booked_at&status=eq.active&arrival_date=lt.${currentYearStart}&order=arrival_date.asc&limit=1000&offset=1000`),
    sb(`bookings?select=property_id,arrival_date,departure_date&status=eq.blocked&arrival_date=lt.${currentYearStart}&order=arrival_date.asc`),
  ]);

  return { tyBlocked, histActive: [...histPage1, ...histPage2], histBlocked };
}

// ─── Tax Rules ────────────────────────────────────────────────────────────────

async function fetchTaxRates() {
  // Returns { 5: 0.13, 6: 0.1275, 7: 0.1402, 8: 0.1402 }
  const rows = await sb('tax_rules?is_active=eq.true&select=property_id,rate');
  const totals = {};
  for (const row of rows) {
    totals[row.property_id] = (totals[row.property_id] || 0) + Number(row.rate) / 100;
  }
  return totals;
}

// ─── Events Cache ─────────────────────────────────────────────────────────────

function fetchEventsCache() {
  try {
    const cachePath = join(__dirname, 'events-cache.json');
    if (!existsSync(cachePath)) return [];
    const data = JSON.parse(readFileSync(cachePath, 'utf8'));
    return data.events || [];
  } catch {
    return [];
  }
}

// Compute historical ADR for an event's date window from histActive bookings.
// Uses proration — counts only nights and revenue within the event dates.
// Returns { adr, nights, years } or null if insufficient data.
function computeEventADR(event, histActive, propId) {
  const currentYear = parseInt(today().slice(0, 4));
  const eventMonth  = event.start_date.slice(5, 7); // MM
  const eventDay    = event.start_date.slice(8, 10); // DD
  const eventMonthE = event.end_date.slice(5, 7);
  const eventDayE   = event.end_date.slice(8, 10);

  const propBookings = histActive.filter(b => b.property_id === propId);
  if (!propBookings.length) return null;

  const earliest = Math.min(...propBookings.map(b => parseInt(b.arrival_date.slice(0, 4))));
  const byYear   = {};

  for (let yr = earliest; yr < currentYear; yr++) {
    // Build the event window for this historical year, accounting for cross-year events
    const evStart = `${yr}-${eventMonth}-${eventDay}`;
    const endYear = event.end_date.slice(5, 7) < event.start_date.slice(5, 7) ? yr + 1 : yr;
    const evEnd   = addDays(`${endYear}-${eventMonthE}-${eventDayE}`, 1); // exclusive end

    let revenue = 0;
    let nights  = 0;
    for (const b of propBookings) {
      const { revenue: r, nights: n } = prorateToMonth(
        b,
        evStart,
        evEnd,
      );
      revenue += r;
      nights  += n;
    }
    if (nights > 0) byYear[yr] = { revenue, nights };
  }

  const years = Object.keys(byYear).length;
  if (!years) return null;

  const totalRevenue = Object.values(byYear).reduce((s, v) => s + v.revenue, 0);
  const totalNights  = Object.values(byYear).reduce((s, v) => s + v.nights, 0);
  return { adr: totalRevenue / totalNights, nights: totalNights, years };
}

// ─── PriceLabs Data (supplied externally by CoWork routine) ───────────────────
// Format: { "471179": { "2026-05-27": { price, user_price, demand_desc, min_stay, unbookable, booking_status }, ... }, ... }

// Fetch prices from PriceLabs REST API for all 4 properties
// Returns plData in format: { "471179": { "YYYY-MM-DD": { price, user_price, demand_desc, min_stay, unbookable, booking_status } } }
async function fetchPriceLabsData(fromDate, toDate) {
  if (!PRICELABS_KEY) return null;
  const listings = PROPERTIES.map(p => ({ id: p.plId, pms: 'ownerrez', dateFrom: fromDate, dateTo: toDate }));
  const res = await fetch('https://api.pricelabs.co/v1/listing_prices', {
    method: 'POST',
    headers: { 'X-API-Key': PRICELABS_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ listings }),
  });
  if (!res.ok) { console.warn('PriceLabs API error:', res.status, await res.text()); return null; }
  const raw = await res.json();
  // Transform: array of { id, data: [...] } → { plId: { date: priceObj } }
  const plData = {};
  for (const listing of (Array.isArray(raw) ? raw : (raw.listings || []))) {
    if (listing.error) { console.warn(`PriceLabs ${listing.id}: ${listing.error_status}`); continue; }
    plData[listing.id] = {};
    for (const row of (listing.data || listing.prices || [])) {
      // Store ALL dates — sectionPrices filters to open dates via Supabase bookings;
      // sectionPricingAlerts needs all dates (including booked) for price analysis
      plData[listing.id][row.date] = {
        price: row.price, user_price: row.user_price,
        demand_desc: row.demand_desc, min_stay: row.min_stay,
        unbookable: row.unbookable, booking_status: row.booking_status,
      };
    }
  }
  return plData;
}

// Fallback: load PriceLabs data from a pre-generated JSON file (CoWork routine path)
function loadPriceLabsFile() {
  if (!PL_DATA_FILE) return null;
  try { return JSON.parse(readFileSync(PL_DATA_FILE, 'utf8')); }
  catch (e) { console.warn('Could not read PRICELABS_DATA_FILE:', e.message); return null; }
}

// Write RED/YELLOW pricing alerts to pricing_actions table.
// Skips windows that already have a pending action today.
async function savePricingActions(plData, alertData, bookings, todayStr) {
  if (!SUPABASE_URL || !SUPABASE_KEY || !alertData || !plData) return 0;

  // Fetch existing pending actions created today to avoid duplicates
  const sinceToday = todayStr + 'T00:00:00Z';
  const existingRes = await fetch(
    `${SUPABASE_URL}/rest/v1/pricing_actions?status=eq.pending&created_at=gte.${sinceToday}&select=property_id,window_label`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  const existing = existingRes.ok ? await existingRes.json() : [];
  const existingKey = new Set(existing.map(r => `${r.property_id}:${r.window_label}`));

  const toInsert = [];
  for (const prop of PROPERTIES) {
    const alerts = computePropertyAlerts(prop, plData, alertData, bookings, todayStr);
    const settings = alertData[prop.plId]?.settings;
    const currentBase = settings?.base ?? null;

    for (const a of alerts) {
      if (a.level !== 'RED' && a.level !== 'YELLOW') continue;
      if (existingKey.has(`${prop.id}:${a.window}`)) continue;

      const reductionPct = a.level === 'RED' ? 0.15 : 0.10;
      const recommendedBase = currentBase ? Math.round(currentBase * (1 - reductionPct)) : null;

      toInsert.push({
        property_id:            prop.id,
        pricelabs_listing_id:   prop.plId,
        window_label:           a.window,
        alert_level:            a.level,
        current_avg_price:      a.avgPrice,
        recommended_base_price: recommendedBase,
        market_median:          a.mktP50,
        reason:                 a.action,
        overpriced_dates:       a.overpricedDates,
        property_occ:           a.propOcc ?? null,
        market_occ:             a.mktOcc  ?? null,
        status:                 'pending',
      });
    }
  }

  if (toInsert.length === 0) return 0;

  const res = await fetch(`${SUPABASE_URL}/rest/v1/pricing_actions`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(toInsert),
  });
  if (!res.ok) throw new Error(`pricing_actions insert ${res.status}: ${await res.text()}`);
  return toInsert.length;
}

// Snapshot today's PriceLabs prices to Supabase for historical analysis.
// Upserts on (property_id, date) — safe to run daily, overwrites with latest data.
async function snapshotPriceLabsData(plData, capturedAt) {
  const rows = [];
  for (const prop of PROPERTIES) {
    const prices = plData[prop.plId] || {};
    for (const [date, row] of Object.entries(prices)) {
      if (!row) continue;
      rows.push({
        property_id:           prop.id,
        pricelabs_listing_id:  prop.plId,
        date,
        recommended_price:     row.price > 0  ? row.price     : null,
        user_price:            row.user_price > 0 ? row.user_price : null, // -1 = no override
        uncustomized_price:    null,   // not in current plData structure
        min_stay:              row.min_stay  || null,
        booking_status:        row.booking_status ?? '',
        demand_level:          row.demand_desc || null,
        adr:                   null,   // filled later from actual bookings
        captured_at:           capturedAt,
      });
    }
  }
  if (!rows.length) return 0;

  const CHUNK = 500;
  let upserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/pricing_snapshots`, {
      method: 'POST',
      headers: {
        apikey:         SUPABASE_KEY,
        Authorization:  `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer:         'resolution=merge-duplicates',
      },
      body: JSON.stringify(rows.slice(i, i + CHUNK)),
    });
    if (!r.ok) {
      const err = await r.text();
      console.warn(`  pricing_snapshots chunk ${Math.floor(i/CHUNK)+1} failed: ${err.slice(0, 120)}`);
    } else {
      upserted += rows.slice(i, i + CHUNK).length;
    }
  }
  return upserted;
}

// ─── PriceLabs Pricing Alerts ─────────────────────────────────────────────────

async function plGet(path) {
  const res = await fetch(`https://api.pricelabs.co/v1${path}`, {
    headers: { 'X-API-Key': PRICELABS_KEY },
  });
  if (!res.ok) { console.warn(`PriceLabs GET ${path} ${res.status}`); return null; }
  return res.json();
}

// Fetch listing settings (occupancy vs market) + neighborhood market percentiles for all properties
async function fetchPricingAlertData() {
  if (!PRICELABS_KEY) return null;
  try {
    // /listings returns all 4 with occupancy_next_30/60 and market_occupancy_next_30/60
    const allSettings = await plGet('/listings').then(d => d?.listings || []).catch(() => []);

    // Neighborhood data (market percentiles) per property — these are large, fetch in parallel
    const marketResults = await Promise.all(
      PROPERTIES.map(p =>
        plGet(`/neighborhood_data?pms=ownerrez&listing_id=${p.plId}`)
          .then(d => ({ plId: p.plId, data: d }))
          .catch(() => ({ plId: p.plId, data: null }))
      )
    );

    const result = {};
    for (const p of PROPERTIES) {
      result[p.plId] = {
        settings: allSettings.find(s => String(s.id) === p.plId) || null,
        market:   marketResults.find(r => r.plId === p.plId)?.data || null,
      };
    }
    return result;
  } catch (e) {
    console.warn('  Pricing alert data fetch failed:', e.message);
    return null;
  }
}

// Parse "25 %" → 0.25, null/undefined → null
function parseOcc(str) {
  if (str == null) return null;
  const n = parseFloat(str);
  return isNaN(n) ? null : n / 100;
}

// Convert cumulative occupancy (occ_next_30, occ_next_60) to per-window rates
// window 30 = days 1-30, window 60 = days 31-60
function windowOcc(occ30str, occ60str, windowEnd) {
  const o30 = parseOcc(occ30str) ?? 0;
  const o60 = parseOcc(occ60str) ?? 0;
  if (windowEnd === 30) return o30;
  if (windowEnd === 60) return Math.max(0, (o60 * 60 - o30 * 30) / 30);
  return null; // 61-90 not available
}

// Build date → market occupancy rate lookup from neighborhood_data "Future Occ/New/Canc"
function parseMarketOccupancy(marketData, bedroomCount) {
  if (!marketData?.data) return {};
  const foc = marketData.data['Future Occ/New/Canc'];
  if (!foc?.Category) return {};
  const catKey = String(bedroomCount);
  const category = foc.Category[catKey] || foc.Category['1'] || Object.values(foc.Category)[0];
  if (!category) return {};
  const dates = category.X_values || [];
  // Future Occ Y_values is double-nested: Y_values[0][0] = actual data array
  const rawOcc    = (category.Y_values || [])[0];
  const occSeries = Array.isArray(rawOcc?.[0]) ? rawOcc[0] : (rawOcc || []); // Label[0] = "Occupancy"
  const map = {};
  dates.forEach((d, i) => { if (occSeries[i] != null) map[d] = occSeries[i] / 100; });
  return map;
}

// Property occupancy for a specific day window, calculated from Supabase bookings
function propOccFromBookings(bookings, propId, startDay, endDay, todayStr) {
  const occ = occupiedSet(bookings, propId);
  let booked = 0;
  for (let i = startDay; i < endDay; i++) {
    if (occ.has(addDays(todayStr, i))) booked++;
  }
  return booked / (endDay - startDay);
}

// Build date → { p25, p50, p75 } lookup from neighborhood_data for a given bedroom count
function parseMarketPercentiles(marketData, bedroomCount) {
  if (!marketData?.data) return {};
  const fpp = marketData.data['Future Percentile Prices'];
  if (!fpp?.Category) return {};

  // Category keys are bedroom counts as strings; fall back to "1" if exact key missing
  const catKey = String(bedroomCount);
  const category = fpp.Category[catKey] || fpp.Category['1'] || Object.values(fpp.Category)[0];
  if (!category) return {};

  const dates   = category.X_values || [];
  const yVals   = category.Y_values || [];
  const p25s = yVals[0] || [], p50s = yVals[1] || [], p75s = yVals[2] || [];

  const map = {};
  dates.forEach((d, i) => {
    map[d] = { p25: p25s[i] ?? null, p50: p50s[i] ?? null, p75: p75s[i] ?? null };
  });
  return map;
}

// Compute alerts for a single property across three windows
function computePropertyAlerts(prop, plData, alertData, bookings, todayStr) {
  const propAlertData = alertData?.[prop.plId];
  if (!propAlertData?.settings || !propAlertData?.market) return [];

  const { settings, market } = propAlertData;
  const bedroomCount  = settings.no_of_bedrooms ?? 1;
  const percentiles   = parseMarketPercentiles(market, bedroomCount);
  const mktOccByDate  = parseMarketOccupancy(market, bedroomCount);
  const prices        = plData?.[prop.plId] ?? {};
  const occ           = occupiedSet(bookings, prop.id); // open nights only — booked nights can't be repriced

  // Market occupancy for days 61-90: average from neighborhood_data occupancy series
  const mktOcc61_90Dates = [];
  for (let i = 60; i < 90; i++) mktOcc61_90Dates.push(addDays(todayStr, i));
  const mktOcc61_90Values = mktOcc61_90Dates.map(d => mktOccByDate[d]).filter(v => v != null);
  const mktOcc61_90 = mktOcc61_90Values.length
    ? mktOcc61_90Values.reduce((s, v) => s + v, 0) / mktOcc61_90Values.length
    : null;

  const windows = [
    {
      label:    `Next 30 days (${fmtDate(todayStr)}–${fmtDate(addDays(todayStr, 29))})`,
      startDay: 0, endDay: 30,
      propOcc:  windowOcc(settings.occupancy_next_30, settings.occupancy_next_60, 30),
      mktOcc:   windowOcc(settings.market_occupancy_next_30, settings.market_occupancy_next_60, 30),
    },
    {
      label:    `Days 31–60 (${fmtDate(addDays(todayStr, 30))}–${fmtDate(addDays(todayStr, 59))})`,
      startDay: 30, endDay: 60,
      propOcc:  windowOcc(settings.occupancy_next_30, settings.occupancy_next_60, 60),
      mktOcc:   windowOcc(settings.market_occupancy_next_30, settings.market_occupancy_next_60, 60),
    },
    {
      label:    `Days 61–90 (${fmtDate(addDays(todayStr, 60))}–${fmtDate(addDays(todayStr, 89))})`,
      startDay: 60, endDay: 90,
      propOcc:  propOccFromBookings(bookings, prop.id, 60, 90, todayStr),
      // Market occ from neighborhood_data is unreliable for 61-90 day window —
      // it reflects advance bookings already made, not true market occupancy.
      // Use null so alert logic falls back to pricing thresholds only.
      mktOcc:   null,
    },
  ];

  const alerts = [];

  for (const win of windows) {
    // Collect OPEN dates only — booked nights can't be repriced, so exclude them
    const windowDates = [];
    for (let i = win.startDay; i < win.endDay; i++) windowDates.push(addDays(todayStr, i));

    const datesWithPrice = windowDates.filter(d => prices[d]?.price != null && prices[d].price > 0 && !occ.has(d));
    if (datesWithPrice.length === 0) continue;

    // Use `price` field only — this is the final channel price (what guests see)
    const avgPrice = datesWithPrice.reduce((s, d) => s + prices[d].price, 0) / datesWithPrice.length;

    // Market percentile averages for this window
    const mktPoints = windowDates.map(d => percentiles[d]).filter(Boolean);
    if (mktPoints.length === 0) continue;
    const avgP50 = mktPoints.reduce((s, m) => s + (m.p50 ?? 0), 0) / mktPoints.length;
    const avgP75 = mktPoints.reduce((s, m) => s + (m.p75 ?? 0), 0) / mktPoints.length;
    if (!avgP50 || !avgP75) continue;

    const nightsAboveP75 = datesWithPrice.filter(d => prices[d].price > avgP75).length;
    const pctAboveP75    = nightsAboveP75 / datesWithPrice.length;

    const propOcc = win.propOcc;
    const mktOcc  = win.mktOcc;
    const hasOccData = propOcc != null && mktOcc != null;

    const occupancyBeatMarket = hasOccData && propOcc >= mktOcc;
    const occupancyGap        = hasOccData ? mktOcc - propOcc : 0;
    const occupancyHalfMkt    = hasOccData && mktOcc > 0 && propOcc < mktOcc * 0.5;

    let level = null, reason = null;

    // Do NOT flag if property occupancy is at/above market — correct peak-season behavior
    if (!occupancyBeatMarket) {
      if (hasOccData) {
        if (occupancyHalfMkt) { level = 'RED'; reason = 'occupancy_gap'; }
        else if (pctAboveP75 > 0.30 && occupancyGap > 0.10) { level = 'RED'; reason = 'overpriced'; }
      }
      if (!level && pctAboveP75 > 0.20) { level = 'YELLOW'; reason = 'overpriced'; }
      if (!level && avgP50 > 0 && avgPrice > avgP50 * 1.15) { level = 'YELLOW'; reason = 'above_market'; }
    }
    const ptsAbove = avgP50 > 0 ? Math.round((avgPrice / avgP50 - 1) * 100) : 0;
    let action;
    if (!level) {
      action = '✓ Within normal range';
    } else if (level === 'RED' && reason === 'overpriced') {
      action = `Reduce pricing now — ${ptsAbove}% above market median with occupancy lagging. Drop base price in PriceLabs before the booking window closes.`;
    } else if (level === 'RED' && reason === 'occupancy_gap') {
      action = 'Pricing is in line with market — check listing rank, photos, and reviews on Airbnb/VRBO. Low visibility may be the cause.';
    } else if (reason === 'overpriced') {
      action = `Reduce prices in PriceLabs for this window — ${nightsAboveP75} of ${datesWithPrice.length} open nights above p75. Act before the booking window closes.`;
    } else {
      action = `Reduce base price in PriceLabs — avg price ${ptsAbove}% above market median. Adjust now to attract advance bookings.`;
    }

    const overpricedDates = datesWithPrice
      .filter(d => prices[d].price > (percentiles[d]?.p75 ?? avgP75))
      .map(d => ({
        date:  d,
        price: Math.round(prices[d].price),
        p75:   Math.round(percentiles[d]?.p75 ?? avgP75),
      }));

    alerts.push({
      window: win.label, level: level || 'OK',
      avgPrice: Math.round(avgPrice),
      mktP50:   Math.round(avgP50),
      nightsAboveP75, totalNights: datesWithPrice.length,
      propOcc: propOcc != null ? Math.round(propOcc * 100) : null,
      mktOcc:  mktOcc  != null ? Math.round(mktOcc  * 100) : null,
      action,
      overpricedDates,
    });
  }

  return alerts;
}

function sectionPricingAlerts(plData, alertData, bookings, todayStr) {
  let html = `<h2 id="section-pricing" style="${H2}">🚨 Pricing Alerts</h2>`;

  if (!PRICELABS_KEY || !alertData || !plData) {
    return html + `<p style="color:#888;font-style:italic;font-size:13px;">PriceLabs data required for pricing alerts.</p>`;
  }

  const RED_BG = '#fff0f0', RED_COLOR = '#c0392b', RED_BADGE = '#fde8e8';
  const YLW_BG = '#fffbf0', YLW_COLOR = '#d97706', YLW_BADGE = '#fef3c7';
  const GRN_COLOR = '#1a7f5a';

  // Collect rows for ALL properties × ALL windows (not just alerting ones)
  const allRows = [];
  for (const prop of PROPERTIES) {
    const propRows = computePropertyAlerts(prop, plData, alertData, bookings, todayStr);
    propRows.forEach(a => allRows.push({ prop, ...a }));
  }

  const redAlerts = allRows.filter(a => a.level === 'RED');
  const ylwAlerts = allRows.filter(a => a.level === 'YELLOW');

  if (redAlerts.length) {
    html += `<div style="padding:6px 12px;background:${RED_BADGE};border-radius:6px;margin-bottom:10px;font-size:12px;color:${RED_COLOR};font-weight:700;">
      🔴 ${redAlerts.length} RED alert${redAlerts.length > 1 ? 's' : ''} — immediate attention needed
    </div>`;
  } else if (ylwAlerts.length === 0) {
    html += `<div style="padding:6px 12px;background:#f0faf5;border-radius:6px;margin-bottom:10px;font-size:12px;color:${GRN_COLOR};font-weight:600;">
      ✓ All properties pricing within normal range
    </div>`;
  }

  html += `<table style="width:100%;border-collapse:collapse;font-size:12px;">
    <tr style="background:#f8f9fa;">
      <th style="${TH}">Property</th>
      <th style="${TH}">Window</th>
      <th style="${TH}text-align:center;">Status</th>
      <th style="${TH}text-align:right;">Avg Price</th>
      <th style="${TH}text-align:right;">Mkt Median</th>
      <th style="${TH}text-align:right;">Open Nts &gt;p75</th>
      <th style="${TH}text-align:right;">Occ / Mkt</th>
      <th style="${TH}">Action</th>
    </tr>`;

  for (const a of allRows) {
    const isRed = a.level === 'RED';
    const isYlw = a.level === 'YELLOW';
    const isOK  = a.level === 'OK';
    const rowBg     = isRed ? RED_BG : isYlw ? YLW_BG : '#fff';
    const levelColor = isRed ? RED_COLOR : isYlw ? YLW_COLOR : GRN_COLOR;
    const levelLabel = isOK ? '✓ OK' : a.level;
    const occStr = a.propOcc != null && a.mktOcc != null ? `${a.propOcc}% / ${a.mktOcc}%` : '—';
    html += `<tr style="background:${rowBg};border-bottom:1px solid #f0f0f0;">
      <td style="padding:7px 10px;">${badge(a.prop.name, a.prop.color)}</td>
      <td style="padding:7px 10px;color:#555;">${a.window}</td>
      <td style="padding:7px 10px;text-align:center;">
        <span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700;background:${levelColor}22;color:${levelColor};">${levelLabel}</span>
      </td>
      <td style="padding:7px 10px;text-align:right;font-weight:600;">${fmt$(a.avgPrice)}</td>
      <td style="padding:7px 10px;text-align:right;color:#666;">${fmt$(a.mktP50)}</td>
      <td style="padding:7px 10px;text-align:right;color:#666;">${a.nightsAboveP75} / ${a.totalNights}</td>
      <td style="padding:7px 10px;text-align:right;color:#666;">${occStr}</td>
      <td style="padding:7px 10px;color:${isOK ? '#888' : '#444'};font-size:11px;">${a.action}</td>
    </tr>`;
  }
  html += `</table>`;
  return html;
}

// ─── Business Logic ───────────────────────────────────────────────────────────

function occupiedSet(bookings, propId) {
  const s = new Set();
  for (const b of bookings) {
    if (b.property_id !== propId) continue;
    let d = b.arrival_date;
    while (d < b.departure_date) { s.add(d); d = addDays(d, 1); }
  }
  return s;
}

function openDates(bookings, propId, from, to) {
  const occ = occupiedSet(bookings, propId);
  const dates = [];
  let d = from;
  while (d < to) { if (!occ.has(d)) dates.push(d); d = addDays(d, 1); }
  return dates;
}

function gapNights(bookings, propId, from, to) {
  const sorted = bookings
    .filter(b => b.property_id === propId)
    .sort((a, b) => a.arrival_date.localeCompare(b.arrival_date));
  const gaps = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const gStart = sorted[i].departure_date;
    const gEnd   = sorted[i + 1].arrival_date;
    const nights = diffDays(gStart, gEnd);
    if (nights >= 1 && nights <= 5 && gEnd >= from && gStart <= to) {
      const dates = [];
      let d = gStart;
      while (d < gEnd) { dates.push(d); d = addDays(d, 1); }
      const prevRPN = rentPerNight(sorted[i]);
      const nextRPN = rentPerNight(sorted[i+1]);
      // Use average of adjacent bookings' nightly rate as the gap discount base
      const baseRPN = (prevRPN && nextRPN) ? (prevRPN + nextRPN) / 2 : (prevRPN || nextRPN);
      gaps.push({ nights, dates, checkOut: gStart, checkIn: gEnd,
        prevGuest: sorted[i].guest_display_name, prevChannel: sorted[i].booking_channel,
        nextGuest: sorted[i+1].guest_display_name, nextChannel: sorted[i+1].booking_channel,
        baseRentPerNight: baseRPN ? Math.round(baseRPN * 100) / 100 : null,
      });
    }
  }
  return gaps;
}

// Build the discount offer table for a gap night
// baseRentPerNight = charges_json rent / nights from adjacent booking (= PriceLabs net target)
// taxRate = total property tax rate as a decimal (e.g. 0.13)
// prevChannel / nextChannel = booking channels of adjacent guests
function gapDiscountTable(baseRentPerNight, taxRate, prevChannel, nextChannel) {
  if (!baseRentPerNight || baseRentPerNight < 0) return '';
  const tax = taxRate || 0;
  const channels = [...new Set([prevChannel, nextChannel].filter(Boolean))];
  const tiers = [20, 25, 30, 35];

  // Column headers — one "Your Net" per unique channel
  const channelHeaders = channels.map(ch =>
    `<th style="padding:5px 8px;text-align:right;color:#555;font-weight:600;">Your Net<br><span style="font-weight:400;font-size:10px;">${ch}</span></th>`
  ).join('');

  let rows = '';
  for (const pct of tiers) {
    // Guest's per-night rent after discount (what they pay for rent, excl. taxes)
    const discountedRent = Math.round(baseRentPerNight * (1 - pct / 100) * 100) / 100;
    // Total guest pays per gap night including all taxes
    const guestTotal = Math.round(discountedRent * (1 + tax) * 100) / 100;
    // Chris's net per night from rent (after channel fee, taxes go to authorities)
    const netCols = channels.map(ch =>
      `<td style="padding:5px 8px;text-align:right;color:#555;">${fmt$(Math.round(discountedRent * (1 - channelFee(ch))))}</td>`
    ).join('');
    const suggested = pct === 25;
    rows += `<tr style="${suggested ? 'background:#f0f9f4;font-weight:700;' : ''}border-bottom:1px solid #f0f0f0;">
      <td style="padding:5px 8px;color:${suggested ? '#1a7f5a' : '#333'};">${suggested ? '★ ' : ''}${pct}% off</td>
      <td style="padding:5px 8px;text-align:right;">${fmt$(discountedRent)}</td>
      <td style="padding:5px 8px;text-align:right;font-weight:${suggested?'700':'400'};">${fmt$(guestTotal)}</td>
      ${netCols}
    </tr>`;
  }
  return `<table style="width:100%;border-collapse:collapse;font-size:12px;margin-top:8px;">
    <tr style="background:#f8f9fa;">
      <th style="padding:5px 8px;text-align:left;color:#555;font-weight:600;">Offer</th>
      <th style="padding:5px 8px;text-align:right;color:#555;font-weight:600;">Rent/Night</th>
      <th style="padding:5px 8px;text-align:right;color:#555;font-weight:600;">Guest Pays<br><span style="font-weight:400;font-size:10px;">incl. ${(tax*100).toFixed(2)}% tax</span></th>
      ${channelHeaders}
    </tr>${rows}
  </table>`;
}

function revenueByProp(rows) {
  const r = {};
  for (const p of PROPERTIES) r[p.id] = { gross: 0, net: 0, nights: 0, count: 0 };
  for (const row of rows) {
    if (!r[row.property_id]) continue;
    r[row.property_id].gross  += Number(row.gross_revenue) || 0;
    r[row.property_id].net    += Number(row.net_revenue) || 0;
    r[row.property_id].nights += Number(row.nights) || 0;
    r[row.property_id].count++;
  }
  return r;
}

// ─── Revenue Forecast ────────────────────────────────────────────────────────

function computeLYActual(prop, paceMonth, histActive) {
  let revenue = 0;
  for (const b of histActive) {
    if (b.property_id !== prop.id) continue;
    revenue += prorateToMonth(b, paceMonth.lyStart, paceMonth.lyEnd).revenue;
  }
  return revenue;
}

// Core fill-rate + projection engine for one property × one forecast month.
function computePropertyForecast(prop, paceMonth, todayStr, tyBookings, tyBlocked, histActive, histBlocked, plData) {
  const currentYear = parseInt(todayStr.slice(0, 4));
  const monthNum    = parseInt(paceMonth.start.split('-')[1]);
  const todayDay    = parseInt(todayStr.split('-')[2]);
  const daysInMonth = diffDays(paceMonth.start, paceMonth.end);

  // Build date sets for confirmed bookings and blocks within this month
  const confirmedDates = new Set();
  const blockedDates   = new Set();

  const addDatesToSet = (bookings, set) => {
    for (const b of bookings) {
      if (b.property_id !== prop.id) continue;
      let d = b.arrival_date < paceMonth.start ? paceMonth.start : b.arrival_date;
      while (d < b.departure_date && d < paceMonth.end) { set.add(d); d = addDays(d, 1); }
    }
  };
  addDatesToSet(tyBookings, confirmedDates);
  addDatesToSet(tyBlocked,  blockedDates);

  // Confirmed revenue (prorated across month boundaries)
  let confirmedRevenue = 0;
  for (const b of tyBookings) {
    if (b.property_id !== prop.id) continue;
    confirmedRevenue += prorateToMonth(b, paceMonth.start, paceMonth.end).revenue;
  }
  const confirmedNights = confirmedDates.size;
  const blockedNights   = blockedDates.size;
  const availableDays   = daysInMonth - blockedNights;

  // Open nights remaining: from today for current month; full month for future months
  const openStart = paceMonth.start >= todayStr ? paceMonth.start : todayStr;
  const openDates = [];
  let d = openStart;
  while (d < paceMonth.end) {
    if (!confirmedDates.has(d) && !blockedDates.has(d)) openDates.push(d);
    d = addDays(d, 1);
  }
  const openNights = openDates.length;

  // Historical fill rate — use ALL available prior years back to first booking
  const propHistActive  = histActive.filter(b => b.property_id === prop.id);
  const propHistBlocked = histBlocked.filter(b => b.property_id === prop.id);

  const earliestYear = propHistActive.length > 0
    ? Math.min(...propHistActive.map(b => parseInt(b.arrival_date.slice(0, 4))))
    : currentYear - 1;

  const fillRates        = [];
  const fullyBookedYears = [];
  const lyMonthStr       = String(monthNum).padStart(2, '0');

  for (let yr = currentYear - 1; yr >= earliestYear; yr--) {
    const lyStart = `${yr}-${lyMonthStr}-01`;
    const lyEnd   = new Date(Date.UTC(yr, monthNum, 1)).toISOString().slice(0, 10);
    const lyDays  = diffDays(lyStart, lyEnd);

    // Clamp same-day to handle shorter months (e.g., forecasting Mar when today is Jan 31)
    const sameDay   = Math.min(todayDay, lyDays);
    const samePoint = `${yr}-${lyMonthStr}-${String(sameDay).padStart(2, '0')}`;

    // Historical blocked dates in this month
    const lyBlockedDates = new Set();
    for (const b of propHistBlocked) {
      if (b.arrival_date >= lyEnd || b.departure_date <= lyStart) continue;
      let dt = b.arrival_date < lyStart ? lyStart : b.arrival_date;
      while (dt < b.departure_date && dt < lyEnd) { lyBlockedDates.add(dt); dt = addDays(dt, 1); }
    }
    const lyAvailable = lyDays - lyBlockedDates.size;

    const lyMonthBookings = propHistActive.filter(b => b.arrival_date >= lyStart && b.arrival_date < lyEnd);
    if (lyMonthBookings.length === 0) continue; // No data for this property in this year/month

    // Nights confirmed at same calendar point
    const lyAtPointDates = new Set();
    for (const b of lyMonthBookings) {
      if (!b.booked_at || b.booked_at.slice(0, 10) > samePoint) continue;
      let dt = b.arrival_date < lyStart ? lyStart : b.arrival_date;
      while (dt < b.departure_date && dt < lyEnd) { lyAtPointDates.add(dt); dt = addDays(dt, 1); }
    }

    // Total nights confirmed by month-end
    const lyTotalDates = new Set();
    for (const b of lyMonthBookings) {
      let dt = b.arrival_date < lyStart ? lyStart : b.arrival_date;
      while (dt < b.departure_date && dt < lyEnd) { lyTotalDates.add(dt); dt = addDays(dt, 1); }
    }

    const lyOpenAtPoint = Math.max(0, lyAvailable - lyAtPointDates.size);

    if (lyOpenAtPoint === 0) {
      fullyBookedYears.push(yr);
      continue;
    }

    const lyFilled  = Math.max(0, lyTotalDates.size - lyAtPointDates.size);
    const fillRate  = Math.min(1.0, lyFilled / lyOpenAtPoint);
    fillRates.push({ yr, fillRate, openAtPoint: lyOpenAtPoint, filled: lyFilled });
  }

  // LY actual revenue (no booked_at filter — final month-end result)
  const lyActualRevenue = computeLYActual(prop, paceMonth, histActive);

  if (fillRates.length === 0 && openNights > 0) {
    return {
      prop, paceMonth, confirmedRevenue, confirmedNights, openNights, availableDays,
      fillRates: [], fullyBookedYears, lyActualRevenue,
      conservative: null, base: null, optimistic: null, isRedFlag: false, isFullyBooked: false,
      error: 'no_fill_rate_data',
    };
  }

  const avgFillRate = fillRates.length > 0
    ? fillRates.reduce((s, r) => s + r.fillRate, 0) / fillRates.length
    : 0;

  // Average PriceLabs price across remaining open nights that have price data
  const propPrices      = plData?.[prop.plId] || {};
  const pricedOpenDates = openDates.filter(d => propPrices[d]?.price > 0);
  const avgPrice        = pricedOpenDates.length > 0
    ? pricedOpenDates.reduce((s, d) => s + propPrices[d].price, 0) / pricedOpenDates.length
    : null;

  const scenario = (mult) => {
    if (openNights === 0) return confirmedRevenue; // Fully booked — confirmed is the projection
    if (avgPrice == null) return null;             // Can't project without prices
    return confirmedRevenue + openNights * Math.min(1.0, avgFillRate * mult) * avgPrice;
  };

  const conservative  = scenario(0.5);
  const base          = scenario(1.0);
  const optimistic    = scenario(1.3);
  const isFullyBooked = openNights === 0;
  const isRedFlag     = base != null && lyActualRevenue > 0 && base < lyActualRevenue * 0.85;

  return {
    prop, paceMonth, confirmedRevenue, confirmedNights, openNights, availableDays,
    avgFillRate, avgPrice, fillRates, fullyBookedYears,
    conservative, base, optimistic, lyActualRevenue,
    isFullyBooked, isRedFlag,
  };
}

// ─── Pricing Intelligence ────────────────────────────────────────────────────

// Returns an urgency note object {text, color, bg} for a given open date, or null if no action needed.
// Logic: as check-in approaches and/or demand is low, escalate urgency.
function pricingUrgencyNote(daysOut, demandDesc, currentPrice, minPrice) {
  const isLow  = demandDesc === 'Low Demand';
  const isNorm = demandDesc === 'Normal Demand';
  const floor  = minPrice || 0;
  const drop10 = Math.max(floor, Math.round(currentPrice * 0.90));
  const drop20 = Math.max(floor, Math.round(currentPrice * 0.80));
  const drop30 = Math.max(floor, Math.round(currentPrice * 0.70));

  if (daysOut <= 3) {
    return { text: `🔴 Last chance — consider ${fmt$(drop30)}`, color: '#c0392b', bg: '#fef5f5' };
  }
  if (daysOut <= 7 && isLow) {
    return { text: `🔴 7d out, low demand — try ${fmt$(drop20)}`, color: '#c0392b', bg: '#fef5f5' };
  }
  if (daysOut <= 7 && isNorm) {
    return { text: `🟡 7d out — monitor daily`, color: '#e67e22', bg: '#fffbf3' };
  }
  if (daysOut <= 14 && isLow) {
    return { text: `🟡 14d out, low demand — consider ${fmt$(drop10)}`, color: '#e67e22', bg: '#fffbf3' };
  }
  if (daysOut <= 30 && isLow) {
    return { text: `👀 30d out, low demand`, color: '#888', bg: '' };
  }
  return null;
}

// ─── HTML Helpers ─────────────────────────────────────────────────────────────

const tag = (prop) =>
  `<span style="display:inline-block;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:700;background:${prop.color}1a;color:${prop.color};border:1px solid ${prop.color}33;">${prop.name}</span>`;

const badge = (text, color) =>
  `<span style="display:inline-block;padding:1px 7px;border-radius:10px;font-size:11px;font-weight:600;background:${color}1a;color:${color};">${text}</span>`;

const DEMAND_COLOR = {
  'Low Demand':       '#e67e22',
  'Normal Demand':    '#1a7f5a',
  'High Demand':      '#2980b9',
  'Very High Demand': '#8e44ad',
};

// ─── Email Sections ───────────────────────────────────────────────────────────

function sectionMTD(mtd, todayStr) {
  const cur = revenueByProp(mtd.cur);
  const ly  = revenueByProp(mtd.ly);
  const monthLabel = new Date(mtd.thisStart + 'T00:00:00Z')
    .toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

  let rows = '', totalCur = 0, totalLY = 0;
  for (const p of PROPERTIES) {
    const c = cur[p.id], l = ly[p.id];
    totalCur += c.gross; totalLY += l.gross;
    const yoy = l.gross ? ((c.gross - l.gross) / l.gross) * 100 : null;
    const yoyStr = yoy != null ? `${yoy >= 0 ? '+' : ''}${Math.round(yoy)}%` : '—';
    const yoyColor = yoy == null ? '#999' : yoy >= 0 ? '#1a7f5a' : '#c0392b';
    rows += `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;">${tag(p)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;text-align:right;font-weight:600;">${fmt$(c.gross)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;text-align:right;color:#666;">${fmt$(l.gross)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;text-align:right;font-weight:600;color:${yoyColor};">${yoyStr}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;text-align:right;color:#888;font-size:12px;">${c.count} bkg · ${c.nights} nts</td>
    </tr>`;
  }
  const totYoY = totalLY ? ((totalCur - totalLY) / totalLY * 100) : null;
  const totYoYStr = totYoY != null ? `${totYoY >= 0 ? '+' : ''}${Math.round(totYoY)}%` : '—';
  const totColor = totYoY == null ? '#999' : totYoY >= 0 ? '#1a7f5a' : '#c0392b';
  rows += `<tr style="background:#f8f9fa;">
    <td style="padding:8px 12px;font-weight:700;">Portfolio Total</td>
    <td style="padding:8px 12px;text-align:right;font-weight:700;">${fmt$(totalCur)}</td>
    <td style="padding:8px 12px;text-align:right;color:#666;">${fmt$(totalLY)}</td>
    <td style="padding:8px 12px;text-align:right;font-weight:700;color:${totColor};">${totYoYStr}</td>
    <td style="padding:8px 12px;"></td>
  </tr>`;

  return `<h2 id="section-mtd" style="${H2}">📊 Month-to-Date Revenue — ${monthLabel}</h2>
  <table style="width:100%;border-collapse:collapse;font-size:13px;">
    <tr style="background:#f8f9fa;">
      <th style="${TH}">Property</th><th style="${TH}text-align:right;">This Month</th>
      <th style="${TH}text-align:right;">Same Pd LY</th><th style="${TH}text-align:right;">YoY</th>
      <th style="${TH}text-align:right;">Volume</th>
    </tr>${rows}
  </table>
  <p style="font-size:11px;color:#aaa;margin:8px 0 0;">Bookings with arrival date in ${monthLabel} through ${fmtDate(todayStr)}. Prior year = same ${Math.round(diffDays(mtd.lyStart, addDays(todayStr,-365))+1)}-day window.</p>`;
}

function sectionBookingPace(tyBookings, lyBookings, paceMonths, todayStr) {
  const lySnapshotLabel = fmtDate(addDays(todayStr, -365));
  let html = `<h2 id="section-pace" style="${H2}">📈 Booking Pace vs Last Year</h2>`;

  // Build dynamic context notes — auto-update as conditions change
  const contextNotes = [];

  // Note 1: Non-Scottsdale properties with zero LY bookings = genuinely new/no prior-year data
  // (Scottsdale zero-LY is explained by the short-notice note below, not a data gap)
  const noLyProps = PROPERTIES.filter(p =>
    !lyBookings.some(b => b.property_id === p.id) &&
    !p.location.includes('Scottsdale')
  );
  if (noLyProps.length > 0)
    contextNotes.push(`${noLyProps.map(p => p.name).join(' & ')} show${noLyProps.length === 1 ? 's' : ''} $0 LY — no prior-year data at this snapshot point`);

  // Note 2: Any pace month in May–Sep for a Scottsdale property = last-minute booking market
  const scPropIds = new Set(PROPERTIES.filter(p => p.location.includes('Scottsdale')).map(p => p.id));
  const hasScottsdaleSummer = paceMonths.some(m => {
    const mo = parseInt(m.start.slice(5, 7));
    return mo >= 5 && mo <= 9;
  }) && scPropIds.size > 0;
  if (hasScottsdaleSummer)
    contextNotes.push('Scottsdale summer books short-notice, so low LY figures there are expected');

  const contextStr = contextNotes.length
    ? ` ${contextNotes.join('. ')}.`
    : '';

  html += `<p style="font-size:12px;color:#888;margin:0 0 16px;">Advance booking snapshot: revenue on books today vs. the same snapshot from ${lySnapshotLabel} last year — not LY final actuals.${contextStr}</p>`;

  for (const month of paceMonths) {
    const ty = {}, ly = {};
    for (const p of PROPERTIES) {
      ty[p.id] = { revenue: 0, nights: 0 };
      ly[p.id] = { revenue: 0, nights: 0 };
    }
    for (const b of tyBookings) {
      if (!ty[b.property_id]) continue;
      const { revenue, nights } = prorateToMonth(b, month.start, month.end);
      ty[b.property_id].revenue += revenue;
      ty[b.property_id].nights  += nights;
    }
    for (const b of lyBookings) {
      if (!ly[b.property_id]) continue;
      const { revenue, nights } = prorateToMonth(b, month.lyStart, month.lyEnd);
      ly[b.property_id].revenue += revenue;
      ly[b.property_id].nights  += nights;
    }

    let rows = '';
    let totTYRev = 0, totLYRev = 0, totTYNts = 0, totLYNts = 0;
    for (const p of PROPERTIES) {
      const tyRev = ty[p.id].revenue, lyRev = ly[p.id].revenue;
      const tyNts = ty[p.id].nights,  lyNts = ly[p.id].nights;
      totTYRev += tyRev; totLYRev += lyRev; totTYNts += tyNts; totLYNts += lyNts;
      const yoy      = lyRev > 0 ? (tyRev - lyRev) / lyRev * 100 : null;
      const yoyStr   = yoy != null ? `${yoy >= 0 ? '+' : ''}${Math.round(yoy)}%` : '—';
      const yoyColor = yoy == null ? '#999' : yoy >= 5 ? '#1a7f5a' : yoy < -5 ? '#c0392b' : '#e67e22';
      rows += `<tr>
        <td style="padding:7px 12px;border-bottom:1px solid #f0f0f0;">${tag(p)}</td>
        <td style="padding:7px 12px;border-bottom:1px solid #f0f0f0;text-align:right;font-weight:600;">${fmt$(Math.round(tyRev))}</td>
        <td style="padding:7px 12px;border-bottom:1px solid #f0f0f0;text-align:right;color:#666;">${fmt$(Math.round(lyRev))}</td>
        <td style="padding:7px 12px;border-bottom:1px solid #f0f0f0;text-align:right;font-weight:600;color:${yoyColor};">${yoyStr}</td>
        <td style="padding:7px 12px;border-bottom:1px solid #f0f0f0;text-align:right;color:#888;font-size:12px;">${Math.round(tyNts)}n / ${Math.round(lyNts)}n</td>
      </tr>`;
    }
    const totYoY    = totLYRev > 0 ? (totTYRev - totLYRev) / totLYRev * 100 : null;
    const totYoYStr = totYoY != null ? `${totYoY >= 0 ? '+' : ''}${Math.round(totYoY)}%` : '—';
    const totColor  = totYoY == null ? '#999' : totYoY >= 5 ? '#1a7f5a' : totYoY < -5 ? '#c0392b' : '#e67e22';
    rows += `<tr style="background:#f8f9fa;">
      <td style="padding:7px 12px;font-weight:700;">Portfolio Total</td>
      <td style="padding:7px 12px;text-align:right;font-weight:700;">${fmt$(Math.round(totTYRev))}</td>
      <td style="padding:7px 12px;text-align:right;color:#666;">${fmt$(Math.round(totLYRev))}</td>
      <td style="padding:7px 12px;text-align:right;font-weight:700;color:${totColor};">${totYoYStr}</td>
      <td style="padding:7px 12px;text-align:right;color:#888;font-size:12px;">${Math.round(totTYNts)}n / ${Math.round(totLYNts)}n</td>
    </tr>`;

    html += `<div style="margin-bottom:20px;">
      <div style="font-size:13px;font-weight:700;color:#444;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid #eee;">
        ${month.label}
        <span style="font-size:11px;font-weight:400;color:#aaa;margin-left:8px;">vs ${month.lyLabel}</span>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <tr style="background:#f8f9fa;">
          <th style="${TH}">Property</th>
          <th style="${TH}text-align:right;">Booked TY</th>
          <th style="${TH}text-align:right;">Booked LY</th>
          <th style="${TH}text-align:right;">YoY</th>
          <th style="${TH}text-align:right;">Nights TY/LY</th>
        </tr>${rows}
      </table>
    </div>`;
  }

  return html;
}

function sectionRevenueForecast(paceMonths, todayStr, tyBookings, tyBlocked, histActive, histBlocked, plData) {
  let html = `<h2 id="section-forecast" style="${H2}">🔮 Revenue Forecast</h2>`;
  html += `<p style="font-size:12px;color:#888;margin:0 0 16px;">Projected month-end revenue: confirmed bookings + expected fill of remaining open nights based on historical patterns.</p>`;

  for (const month of paceMonths) {
    const forecasts = PROPERTIES.map(prop =>
      computePropertyForecast(prop, month, todayStr, tyBookings, tyBlocked, histActive, histBlocked, plData)
    );

    let totConfirmed = 0, totConservative = 0, totBase = 0, totOptimistic = 0, totLY = 0;
    const excludedFromScenarios = [];

    let rows = '';
    for (const f of forecasts) {
      totConfirmed += f.confirmedRevenue;
      totLY        += f.lyActualRevenue;

      const rowBg = f.isRedFlag ? '#fff5f5' : '#fff';

      // Fill rate cell
      let fillRateCell;
      if (f.isFullyBooked) {
        fillRateCell = `<td style="padding:7px 10px;text-align:right;color:#1a7f5a;font-size:11px;">Fully booked</td>`;
      } else if (f.fillRates.length === 0) {
        fillRateCell = `<td style="padding:7px 10px;text-align:right;color:#aaa;">—</td>`;
      } else {
        const pct  = Math.round(f.avgFillRate * 100);
        const yrs  = f.fillRates.length;
        fillRateCell = `<td style="padding:7px 10px;text-align:right;">${pct}%
          <div style="font-size:10px;color:#aaa;">n=${yrs} yr${yrs !== 1 ? 's' : ''}</div></td>`;
      }

      // Scenario cells
      let scenarioCells;
      if (f.isFullyBooked) {
        const v = fmt$(Math.round(f.confirmedRevenue));
        scenarioCells = `
          <td style="padding:7px 10px;text-align:right;color:#888;">${v}</td>
          <td style="padding:7px 10px;text-align:right;font-weight:700;color:#1a7f5a;">${v}</td>
          <td style="padding:7px 10px;text-align:right;color:#888;">${v}</td>`;
        totConservative += f.confirmedRevenue;
        totBase         += f.confirmedRevenue;
        totOptimistic   += f.confirmedRevenue;
      } else if (f.conservative == null) {
        excludedFromScenarios.push(f.prop.name);
        const msg = f.error === 'no_fill_rate_data'
          ? 'Insufficient history'
          : plData ? 'No price data' : 'PriceLabs unavailable';
        scenarioCells = `<td colspan="3" style="padding:7px 10px;text-align:center;color:#aaa;font-size:11px;">${msg}</td>`;
      } else {
        totConservative += f.conservative;
        totBase         += f.base;
        totOptimistic   += f.optimistic;
        const baseColor  = f.isRedFlag ? '#c0392b' : '#1a7f5a';
        scenarioCells = `
          <td style="padding:7px 10px;text-align:right;color:#888;">${fmt$(Math.round(f.conservative))}</td>
          <td style="padding:7px 10px;text-align:right;font-weight:700;color:${baseColor};">${fmt$(Math.round(f.base))}</td>
          <td style="padding:7px 10px;text-align:right;color:#888;">${fmt$(Math.round(f.optimistic))}</td>`;
      }

      // Open nights cell — show avg PL price as subtext
      const openNtsCell = f.isFullyBooked
        ? `<td style="padding:7px 10px;text-align:right;color:#1a7f5a;">0</td>`
        : `<td style="padding:7px 10px;text-align:right;">${f.openNights}${f.avgPrice ? `<div style="font-size:10px;color:#aaa;">avg ${fmt$(Math.round(f.avgPrice))}/nt</div>` : ''}</td>`;

      const lyColor = f.isRedFlag ? '#c0392b' : '#666';
      rows += `<tr style="background:${rowBg};border-bottom:1px solid #f0f0f0;">
        <td style="padding:7px 10px;">${badge(f.prop.name, f.prop.color)}</td>
        <td style="padding:7px 10px;text-align:right;font-weight:600;">${fmt$(Math.round(f.confirmedRevenue))}
          <div style="font-size:10px;color:#aaa;font-weight:400;">${f.confirmedNights} nts</div></td>
        ${openNtsCell}
        ${fillRateCell}
        ${scenarioCells}
        <td style="padding:7px 10px;text-align:right;color:${lyColor};">${fmt$(Math.round(f.lyActualRevenue))}</td>
      </tr>`;

      // Footnote row for years where property was fully booked at this point
      if (f.fullyBookedYears.length > 0) {
        rows += `<tr style="background:${rowBg};">
          <td colspan="8" style="padding:1px 10px 6px 30px;font-size:10px;color:#aaa;">
            Fully booked at this calendar point in ${f.fullyBookedYears.join(', ')} — excluded from fill rate average
          </td>
        </tr>`;
      }
    }

    // Portfolio total row — show partial scenarios with exclusion note if some properties lack data
    const totBaseColor = (totBase > 0 && totLY > 0 && totBase < totLY * 0.85) ? '#c0392b' : '#333';
    const allExcluded  = excludedFromScenarios.length === PROPERTIES.length;
    const someExcluded = excludedFromScenarios.length > 0 && !allExcluded;
    const exclNote     = someExcluded
      ? `<div style="font-size:10px;color:#aaa;font-weight:400;">excl. ${excludedFromScenarios.join(', ')}</div>`
      : '';
    const totScenarioCells = allExcluded
      ? `<td colspan="3" style="padding:7px 12px;"></td>`
      : `<td style="padding:7px 12px;text-align:right;color:#888;">${fmt$(Math.round(totConservative))}${exclNote}</td>
         <td style="padding:7px 12px;text-align:right;font-weight:700;color:${totBaseColor};">${fmt$(Math.round(totBase))}${exclNote}</td>
         <td style="padding:7px 12px;text-align:right;color:#888;">${fmt$(Math.round(totOptimistic))}${exclNote}</td>`;

    rows += `<tr style="background:#f8f9fa;">
      <td style="padding:7px 12px;font-weight:700;">Portfolio Total</td>
      <td style="padding:7px 12px;text-align:right;font-weight:700;">${fmt$(Math.round(totConfirmed))}</td>
      <td style="padding:7px 12px;"></td>
      <td style="padding:7px 12px;"></td>
      ${totScenarioCells}
      <td style="padding:7px 12px;text-align:right;font-weight:700;color:#666;">${fmt$(Math.round(totLY))}</td>
    </tr>`;

    html += `<div style="margin-bottom:20px;">
      <div style="font-size:13px;font-weight:700;color:#444;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid #eee;">
        ${month.label}
        <span style="font-size:11px;font-weight:400;color:#aaa;margin-left:8px;">vs ${month.lyLabel} actual</span>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        <tr style="background:#f8f9fa;">
          <th style="${TH}">Property</th>
          <th style="${TH}text-align:right;">Confirmed</th>
          <th style="${TH}text-align:right;">Open Nts</th>
          <th style="${TH}text-align:right;">Fill Rate</th>
          <th style="${TH}text-align:right;color:#888;">Conservative</th>
          <th style="${TH}text-align:right;color:#1a7f5a;">Base</th>
          <th style="${TH}text-align:right;color:#888;">Optimistic</th>
          <th style="${TH}text-align:right;">LY Actual</th>
        </tr>${rows}
      </table>
    </div>`;
  }

  html += `<p style="font-size:11px;color:#aaa;margin:8px 0 0;">
    Revenue prorated for bookings spanning month boundaries. Fill rate = % of open nights at this same calendar date historically that were booked by month-end, averaged across all available prior years.
    Scenarios: Conservative = 50% of fill rate · Base = 100% · Optimistic = 130%.
    <span style="display:inline-block;background:#fff5f5;color:#c0392b;padding:1px 5px;border-radius:3px;margin-top:2px;">Red row</span> = base projection &gt;15% below last year's actual.
  </p>`;

  return html;
}

// ─── Smart Event Detection ────────────────────────────────────────────────────

const IMPACT_ORDER = { 'very-high': 4, 'high': 3, 'moderate': 2, 'low-moderate': 1, 'watch': 0 };
const IMPACT_COLOR = {
  'very-high':    '#7b2d8b',
  'high':         '#2980b9',
  'moderate':     '#1a7f5a',
  'low-moderate': '#888',
  'watch':        '#d97706',
};
const IMPACT_LABEL = {
  'very-high':    'Very High',
  'high':         'High',
  'moderate':     'Moderate',
  'low-moderate': 'Low-Mod',
  'watch':        '⚠ Watch',
};

function sectionSmartEvents(hardcodedEvents, cachedEvents, plData, histActive, todayStr) {
  let html = `<h2 id="section-events" style="${H2}">📍 Smart Event Detection</h2>`;

  const cutoff90  = addDays(todayStr, 90);
  const cutoff120 = addDays(todayStr, 120);

  // Merge hardcoded + cached (Ticketmaster/ESPN), dedup by id
  const allByKey = new Map();
  for (const ev of [...hardcodedEvents, ...cachedEvents]) {
    if (!allByKey.has(ev.id)) allByKey.set(ev.id, ev);
  }

  // Filter to events overlapping [today, today+120] and split into windows.
  // For Ticketmaster events, only surface high/very-high impact in the main table
  // to avoid noise from hundreds of moderate concerts and regular-season games.
  const upcoming  = []; // next 90 days — full ADR analysis
  const lookahead = []; // 91–120 days — informational only
  let tmModerateCount = 0;

  for (const ev of allByKey.values()) {
    if (ev.end_date < todayStr) continue;
    if (ev.start_date > cutoff120) continue;

    // Ticketmaster moderate events: count but don't surface in tables
    if (ev.source === 'ticketmaster' && ev.impact !== 'high' && ev.impact !== 'very-high') {
      tmModerateCount++;
      continue;
    }

    if (ev.start_date <= cutoff90 || ev.end_date <= cutoff90) {
      upcoming.push(ev);
    } else {
      lookahead.push(ev);
    }
  }

  upcoming.sort((a, b) => a.start_date.localeCompare(b.start_date));
  lookahead.sort((a, b) => a.start_date.localeCompare(b.start_date));

  if (!upcoming.length && !lookahead.length) {
    return html + `<p style="color:#888;font-size:13px;font-style:italic;">No major events detected in the next 120 days.</p>`;
  }

  const sevenDaysAgo = addDays(todayStr, -7);
  const WATCH_BG  = '#fffbf0';
  const WATCH_CLR = '#d97706';
  const RED_BG    = '#fff0f0';
  const RED_CLR   = '#c0392b';
  const AMB_BG    = '#fffbf0';
  const AMB_CLR   = '#d97706';
  const GRN_CLR   = '#1a7f5a';
  const GRY_CLR   = '#888';

  // Build rows for the 0–90 day table
  const tableRows = [];

  for (const ev of upcoming) {
    // Which properties are affected by this market?
    const affectedProps = PROPERTIES.filter(p => PROP_MARKET[p.id] === ev.market);

    for (const prop of affectedProps) {
      const dateRange = ev.start_date === ev.end_date
        ? fmtDate(ev.start_date)
        : `${fmtDate(ev.start_date)} – ${fmtDate(ev.end_date)}`;

      const isNew = ev.discovered_at && ev.discovered_at.slice(0, 10) >= sevenDaysAgo;

      // Historical ADR
      const hist = computeEventADR(ev, histActive, prop.id);

      // Current PriceLabs avg price over these dates
      let currentAvgPrice = null;
      if (plData?.[prop.plId]) {
        const prices = plData[prop.plId];
        const pricedDates = [];
        let d = ev.start_date;
        while (d <= ev.end_date && d <= cutoff90) {
          if (prices[d]?.price > 0) pricedDates.push(prices[d].price);
          d = addDays(d, 1);
        }
        if (pricedDates.length) {
          currentAvgPrice = pricedDates.reduce((s, v) => s + v, 0) / pricedDates.length;
        }
      }

      // Alert logic
      let alertLevel = null; // 'red' | 'amber' | 'green' | 'info'
      let alertText  = '';

      if (ev.is_watch) {
        // Slow season: flag if current price is >20% above historical ADR
        if (hist && currentAvgPrice && currentAvgPrice > hist.adr * 1.20) {
          const pctAbove = Math.round((currentAvgPrice / hist.adr - 1) * 100);
          alertLevel = 'amber';
          alertText  = `Pricing ${pctAbove}% above historical ADR for this slow period. Reduce to attract bookings.`;
        } else if (hist && currentAvgPrice) {
          alertLevel = 'green';
          alertText  = 'Pricing within historical range for slow season. ✓';
        } else {
          alertLevel = 'info';
          alertText  = 'Watch period — price at or below market median.';
        }
      } else if (!hist) {
        alertLevel = 'info';
        alertText  = 'No prior-year data — first occurrence or insufficient history. Monitor closely.';
      } else if (currentAvgPrice && currentAvgPrice < hist.adr * 0.90) {
        const pctBelow = Math.round((1 - currentAvgPrice / hist.adr) * 100);
        alertLevel = 'red';
        alertText  = `Potentially underpriced by ${pctBelow}%. Historical ADR was ${fmt$(Math.round(hist.adr))} — consider raising prices in PriceLabs before guests find this gap.`;
      } else if (currentAvgPrice && currentAvgPrice >= hist.adr * 0.90) {
        alertLevel = 'green';
        alertText  = 'Pricing in line with historical performance. ✓';
      } else {
        alertLevel = 'info';
        alertText  = hist ? `Historical ADR: ${fmt$(Math.round(hist.adr))}. No PriceLabs price data for these dates yet.` : '';
      }

      const rowBg = ev.is_watch ? WATCH_BG : alertLevel === 'red' ? RED_BG : alertLevel === 'amber' ? AMB_BG : '#fff';
      const alertColor = ev.is_watch ? WATCH_CLR : alertLevel === 'red' ? RED_CLR : alertLevel === 'amber' ? AMB_CLR : alertLevel === 'green' ? GRN_CLR : GRY_CLR;
      const alertBadge = alertLevel === 'red' ? '🔴' : alertLevel === 'amber' ? '🟡' : alertLevel === 'green' ? '✓' : 'ℹ';
      const impColor = IMPACT_COLOR[ev.impact] || '#888';
      const histCell = hist
        ? `${fmt$(Math.round(hist.adr))}<div style="font-size:10px;color:#aaa;">n=${hist.years} yr${hist.years!==1?'s':''}</div>`
        : `<span style="color:#aaa;">—</span>`;
      const plCell = currentAvgPrice ? fmt$(Math.round(currentAvgPrice)) : `<span style="color:#aaa;">—</span>`;
      const gapCell = hist && currentAvgPrice
        ? (() => {
            const pct = Math.round((currentAvgPrice / hist.adr - 1) * 100);
            const c   = pct > 10 ? GRN_CLR : pct < -10 ? RED_CLR : '#666';
            return `<span style="color:${c};font-weight:${Math.abs(pct)>10?'700':'400'};">${pct>0?'+':''}${pct}%</span>`;
          })()
        : `<span style="color:#aaa;">—</span>`;

      tableRows.push({ rowBg, ev, prop, dateRange, isNew, impColor, histCell, plCell, gapCell, alertColor, alertBadge, alertText });
    }
  }

  if (tableRows.length) {
    html += `<table style="width:100%;border-collapse:collapse;font-size:12px;">
      <tr style="background:#f8f9fa;">
        <th style="${TH}">Event</th>
        <th style="${TH}">Property</th>
        <th style="${TH}">Dates</th>
        <th style="${TH}text-align:center;">Impact</th>
        <th style="${TH}text-align:right;">Hist ADR</th>
        <th style="${TH}text-align:right;">PL Price</th>
        <th style="${TH}text-align:right;">Gap</th>
        <th style="${TH}">Action</th>
      </tr>`;

    for (const r of tableRows) {
      html += `<tr style="background:${r.rowBg};border-bottom:1px solid #f0f0f0;">
        <td style="padding:7px 10px;">
          <span style="font-weight:600;">${r.ev.name}</span>
          ${r.isNew ? `<span style="display:inline-block;margin-left:4px;padding:0 5px;background:#7b2d8b22;color:#7b2d8b;border-radius:8px;font-size:10px;font-weight:700;">NEW</span>` : ''}
          ${r.ev.source !== 'hardcoded' && r.ev.venue ? `<div style="font-size:10px;color:#aaa;">${r.ev.venue}</div>` : ''}
        </td>
        <td style="padding:7px 10px;">${badge(r.prop.name, r.prop.color)}</td>
        <td style="padding:7px 10px;color:#555;white-space:nowrap;">${r.dateRange}</td>
        <td style="padding:7px 10px;text-align:center;">
          <span style="display:inline-block;padding:2px 7px;border-radius:8px;font-size:10px;font-weight:700;background:${r.impColor}22;color:${r.impColor};">
            ${IMPACT_LABEL[r.ev.impact] || r.ev.impact}
          </span>
        </td>
        <td style="padding:7px 10px;text-align:right;">${r.histCell}</td>
        <td style="padding:7px 10px;text-align:right;font-weight:600;">${r.plCell}</td>
        <td style="padding:7px 10px;text-align:right;">${r.gapCell}</td>
        <td style="padding:7px 10px;color:#444;font-size:11px;">
          <span style="color:${r.alertColor};">${r.alertBadge}</span> ${r.alertText}
        </td>
      </tr>`;
    }
    html += `</table>`;
  } else {
    html += `<p style="color:#888;font-size:13px;font-style:italic;">No events in the next 90 days.</p>`;
  }

  // 91–120 day lookahead — informational only
  if (lookahead.length) {
    html += `<div style="margin-top:16px;padding:12px 16px;background:#f8f9fa;border-radius:6px;border-left:3px solid #ccc;">
      <div style="font-size:12px;font-weight:700;color:#555;margin-bottom:8px;">📅 Coming Up (91–120 days) — informational</div>`;
    for (const ev of lookahead) {
      const affectedProps = PROPERTIES.filter(p => PROP_MARKET[p.id] === ev.market);
      const propNames = affectedProps.map(p => p.name).join(', ');
      const dateRange = ev.start_date === ev.end_date
        ? fmtDate(ev.start_date)
        : `${fmtDate(ev.start_date)} – ${fmtDate(ev.end_date)}`;
      const impColor = IMPACT_COLOR[ev.impact] || '#888';
      const isNew    = ev.discovered_at && ev.discovered_at.slice(0, 10) >= sevenDaysAgo;
      html += `<div style="display:flex;gap:8px;align-items:baseline;padding:3px 0;font-size:12px;border-bottom:1px solid #eee;">
        <span style="color:#666;white-space:nowrap;min-width:100px;">${dateRange}</span>
        <span style="font-weight:600;">${ev.name}${isNew ? ' <span style="color:#7b2d8b;font-size:10px;">NEW</span>' : ''}</span>
        <span style="color:#888;">${propNames}</span>
        <span style="margin-left:auto;padding:1px 6px;border-radius:8px;font-size:10px;font-weight:700;background:${impColor}22;color:${impColor};white-space:nowrap;">${IMPACT_LABEL[ev.impact] || ev.impact}</span>
      </div>`;
    }
    html += `</div>`;
  }

  html += `<p style="font-size:11px;color:#aaa;margin:8px 0 0;">
    Historical ADR = prorated avg nightly revenue from confirmed bookings on these dates in prior years.
    Gap = current PriceLabs price vs historical ADR (positive = you're priced above history).
    🔴 Underpriced: current price &gt;10% below historical ADR.
    Events marked NEW discovered by weekly scan within last 7 days.
    ${tmModerateCount > 0 ? `<br><span style="color:#bbb;">+ ${tmModerateCount} additional moderate-impact events (concerts, minor sports) detected by Ticketmaster scan but not shown — they don't typically drive meaningful STR demand shifts individually.</span>` : ''}
  </p>`;

  return html;
}

function sectionActivity({ newBookings, cancellations }) {
  if (!newBookings.length && !cancellations.length) {
    return `<h2 id="section-activity" style="${H2}">🔔 Activity — Last 24 Hours</h2>
    <p style="color:#888;margin:8px 0;font-style:italic;">No new bookings or cancellations in the last 24 hours.</p>`;
  }
  let html = `<h2 id="section-activity" style="${H2}">🔔 Activity — Last 24 Hours</h2>`;
  if (newBookings.length) {
    html += `<p style="font-weight:600;margin:8px 0 4px;color:#1a7f5a;">✓ ${newBookings.length} New Booking${newBookings.length > 1 ? 's' : ''}</p>`;
    for (const b of newBookings) {
      const p = PROPERTIES.find(x => x.id === b.property_id);
      const n = diffDays(b.arrival_date, b.departure_date);
      html += `<div style="padding:6px 0;border-bottom:1px solid #f4f4f4;font-size:13px;">
        <strong>${b.guest_display_name || 'Guest'}</strong>
        <span style="color:#888;"> · ${p?.name ?? '?'} · ${fmtDate(b.arrival_date)}–${fmtDate(b.departure_date)} (${n}n) · ${b.booking_channel || 'Direct'} · </span>
        <strong style="color:#1a7f5a;">${fmt$(b.gross_revenue)}</strong>
      </div>`;
    }
  }
  if (cancellations.length) {
    html += `<p style="font-weight:600;margin:12px 0 4px;color:#c0392b;">✗ ${cancellations.length} Cancellation${cancellations.length > 1 ? 's' : ''}</p>`;
    for (const b of cancellations) {
      const p = PROPERTIES.find(x => x.id === b.property_id);
      const n = diffDays(b.arrival_date, b.departure_date);
      html += `<div style="padding:6px 0;border-bottom:1px solid #f4f4f4;font-size:13px;">
        <strong>${b.guest_display_name || 'Guest'}</strong>
        <span style="color:#888;"> · ${p?.name ?? '?'} · ${fmtDate(b.arrival_date)}–${fmtDate(b.departure_date)} (${n}n) · ${b.booking_channel || 'Direct'} · </span>
        <strong style="color:#c0392b;">${fmt$(b.gross_revenue)}</strong>
      </div>`;
    }
  }
  return html;
}

function sectionOpenNights(bookings, todayStr, taxRates) {
  const t30 = addDays(todayStr, 30), t60 = addDays(todayStr, 60), t90 = addDays(todayStr, 90);
  let html = `<h2 id="section-gaps" style="${H2}">📅 Open Nights & Gap Opportunities</h2>`;

  for (const p of PROPERTIES) {
    const o30 = openDates(bookings, p.id, todayStr, t30).length;
    const o60 = openDates(bookings, p.id, t30, t60).length;
    const o90 = openDates(bookings, p.id, t60, t90).length;
    const booked = 90 - o30 - o60 - o90;
    const pct = Math.round(booked / 90 * 100);
    const pctColor = pct >= 70 ? '#1a7f5a' : pct >= 40 ? '#e67e22' : '#c0392b';
    const gaps = gapNights(bookings, p.id, todayStr, t90);

    html += `<div style="margin-bottom:22px;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap;">
        ${tag(p)} <span style="font-size:12px;color:#888;">${p.location}</span>
        <span style="margin-left:auto;font-size:12px;font-weight:700;color:${pctColor};">${pct}% booked · next 90 days</span>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <tr style="background:#f8f9fa;">
          <th style="${TH}">Window</th><th style="${TH}text-align:right;">Open Nights</th>
          <th style="${TH}text-align:right;">Booked</th>
        </tr>
        <tr><td style="${TD}">Next 30 days (through ${fmtDate(t30)})</td>
          <td style="${TD}text-align:right;font-weight:${o30>10?'700':'400'};color:${o30>10?'#c0392b':'#333'};">${o30}</td>
          <td style="${TD}text-align:right;color:#888;">${30-o30}</td></tr>
        <tr><td style="${TD}">Days 31–60 (${fmtDate(t30)}–${fmtDate(t60)})</td>
          <td style="${TD}text-align:right;">${o60}</td>
          <td style="${TD}text-align:right;color:#888;">${30-o60}</td></tr>
        <tr><td style="padding:6px 12px;">Days 61–90 (${fmtDate(t60)}–${fmtDate(t90)})</td>
          <td style="padding:6px 12px;text-align:right;">${o90}</td>
          <td style="padding:6px 12px;text-align:right;color:#888;">${30-o90}</td></tr>
      </table>`;

    if (gaps.length) {
      const propTaxRate = taxRates?.[p.id] || 0;
      html += `<div style="margin-top:8px;padding:10px 14px;background:#fff8e1;border-radius:6px;border-left:3px solid #f39c12;">
        <div style="font-size:12px;font-weight:700;color:#e67e22;margin-bottom:8px;">⚡ Gap Nights — outreach opportunities (${gaps.length})</div>`;
      for (const g of gaps) {
        const isLast = gaps.indexOf(g) === gaps.length - 1;
        html += `<div style="margin-bottom:${isLast ? '0' : '16px'};padding-bottom:${isLast ? '0' : '16px'};border-bottom:${isLast ? 'none' : '1px solid #f0e0a0'};">
          <div style="font-size:13px;margin-bottom:3px;">
            <strong>${g.nights === 1 ? '1-night gap' : `${g.nights}-night gap`}:</strong>
            ${g.dates.map(fmtDateL).join(', ')}
          </div>
          <div style="font-size:12px;color:#888;margin-bottom:6px;">
            ← ${g.prevGuest || 'Guest'} checkout ${fmtDate(g.checkOut)} (${g.prevChannel || 'Direct'})
            &nbsp;·&nbsp;
            ${g.nextGuest || 'Guest'} checkin ${fmtDate(g.checkIn)} (${g.nextChannel || 'Direct'}) →
          </div>
          ${g.baseRentPerNight
            ? gapDiscountTable(g.baseRentPerNight, propTaxRate, g.prevChannel, g.nextChannel)
            : `<p style="font-size:12px;color:#aaa;font-style:italic;margin:4px 0;">Rent data unavailable for discount calculation</p>`
          }
        </div>`;
      }
      html += `</div>`;
    }
    html += `</div>`;
  }
  return html;
}

function sectionPrices(bookings, plData, todayStr, alertData) {
  const t90 = addDays(todayStr, 90);
  let html = `<h2 id="section-prices" style="${H2}">💰 Pricing — Open Days (Next 90)</h2>`;

  if (!plData) {
    html += `<p style="color:#888;font-style:italic;font-size:13px;">
      PriceLabs prices unavailable right now — this typically happens during their overnight recalculation (usually complete by 6am AZ time). The 7am scheduled send will have full pricing data.
    </p>`;
    return html;
  }

  for (const p of PROPERTIES) {
    const open = openDates(bookings, p.id, todayStr, t90);
    const propPrices = plData[p.plId] || {};
    // Use live min price from PriceLabs settings; fall back to hardcoded value
    const liveMinPrice = alertData?.[p.plId]?.settings?.min ?? p.minPrice;

    if (!open.length) {
      html += `<div style="margin-bottom:16px;">${tag(p)} <span style="color:#1a7f5a;font-size:13px;margin-left:8px;">Fully booked for the next 90 days 🎉</span></div>`;
      continue;
    }

    // Annotate open dates with PriceLabs data
    const rows = open.slice(0, 30).map(date => ({ date, ...propPrices[date] }));
    const hasData = rows.some(r => r.price != null);

    // Summary flags
    const unbookable = rows.filter(r => r.unbookable === 1);
    const lowDemand  = rows.filter(r => r.demand_desc === 'Low Demand');
    const overrides  = rows.filter(r => r.user_price > 0);

    html += `<div style="margin-bottom:24px;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap;">
        ${tag(p)}
        <span style="font-size:12px;color:#888;">${open.length} open days · ${liveMinPrice ? `min ${fmt$(liveMinPrice)}` : 'no min price'}</span>
        ${unbookable.length ? `<span style="font-size:12px;font-weight:600;color:#e67e22;margin-left:auto;">⚠ ${unbookable.length} unbookable (min stay conflict)</span>` : ''}
        ${lowDemand.length && !unbookable.length ? `<span style="font-size:12px;color:#e67e22;margin-left:auto;">↓ ${lowDemand.length} low-demand days</span>` : ''}
      </div>`;

    if (!hasData) {
      html += `<p style="color:#888;font-size:13px;font-style:italic;margin:4px 0;">No price data available for this property.</p>`;
    } else {
      html += `<table style="width:100%;border-collapse:collapse;font-size:12px;">
        <tr style="background:#f8f9fa;">
          <th style="${TH}">Date</th>
          <th style="${TH}text-align:right;">PL Price</th>
          <th style="${TH}text-align:right;">Override</th>
          <th style="${TH}text-align:right;">Min Stay</th>
          <th style="${TH}">Demand</th>
          <th style="${TH}">Note</th>
        </tr>`;
      for (const r of rows) {
        const demColor = DEMAND_COLOR[r.demand_desc] || '#888';
        const isOverride = r.user_price > 0 && r.user_price !== r.price;
        const isUnbookable = r.unbookable === 1;
        const daysOut = diffDays(todayStr, r.date);
        const urgencyNote = pricingUrgencyNote(daysOut, r.demand_desc, r.price, liveMinPrice);
        const rowBg = isUnbookable ? '#fffbf3' : urgencyNote?.bg || '';
        html += `<tr style="border-bottom:1px solid #f0f0f0;background:${rowBg}">
          <td style="padding:5px 8px;">${fmtDateL(r.date)}</td>
          <td style="padding:5px 8px;text-align:right;font-weight:600;">${fmt$(r.price)}</td>
          <td style="padding:5px 8px;text-align:right;${isOverride?'font-weight:600;color:#2980b9;':'color:#ccc;'}">${isOverride ? fmt$(r.user_price) : '—'}</td>
          <td style="padding:5px 8px;text-align:right;color:#666;">${r.min_stay ?? '—'}</td>
          <td style="padding:5px 8px;">${r.demand_desc ? badge(r.demand_desc, demColor) : ''}</td>
          <td style="padding:5px 8px;font-size:11px;">
            ${isUnbookable ? '<span style="color:#e67e22;">⚠ unbookable</span>' : urgencyNote ? `<span style="color:${urgencyNote.color};">${urgencyNote.text}</span>` : ''}
          </td>
        </tr>`;
      }
      html += `</table>`;
      if (open.length > 30) {
        html += `<p style="font-size:12px;color:#aaa;margin:4px 0;">(${open.length - 30} more open days not shown)</p>`;
      }
    }
    html += `</div>`;
  }
  return html;
}

// ─── Email Shell ──────────────────────────────────────────────────────────────

const H2 = `font-size:15px;font-weight:700;color:#1a1a2e;margin:0 0 14px;padding-bottom:10px;border-bottom:2px solid #f0f0f0;`;
const TH = `padding:7px 12px;text-align:left;font-weight:600;color:#555;`;
const TD = `padding:6px 12px;border-bottom:1px solid #f0f0f0;`;
const SECTION = `background:#fff;border-radius:8px;padding:20px 24px;margin-bottom:16px;border:1px solid #e8e8e8;`;

// Note: SVG icons are stripped by Gmail — using emoji instead for universal rendering

function buildEmail(todayStr, sections, priorityBoardHtml = '') {
  const timeStr = new Date().toLocaleString('en-US', {
    timeZone: 'America/Phoenix', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Daily Revenue Report</title></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#222;">
<div style="max-width:760px;margin:0 auto;padding:20px 16px;">

  <!-- Header -->
  <div style="background:#fff;border-radius:10px;padding:16px 24px;margin-bottom:16px;border:1px solid #e2e8f0;border-top:4px solid #406A94;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">
      <tr>
        <td style="width:64px;min-width:64px;vertical-align:middle;padding:0;">
          <img src="${LOGO_URL}" width="60" height="52" alt="Picture Perfect Stays" style="display:block;border:0;outline:none;width:60px;height:52px;" />
        </td>
        <td style="vertical-align:middle;padding:0 0 0 14px;text-align:right;">
          <p style="margin:0;padding:0;font-size:20px;font-weight:700;color:#0f172a;font-family:-apple-system,BlinkMacSystemFont,Arial,sans-serif;">Daily Revenue Report</p>
          <p style="margin:3px 0 0;padding:0;font-size:12px;color:#64748b;font-family:-apple-system,BlinkMacSystemFont,Arial,sans-serif;">${fmtDateL(todayStr)} · ${timeStr}</p>
        </td>
      </tr>
    </table>
  </div>

  ${priorityBoardHtml}
  ${sections.map(s => `<div style="${SECTION}">${s}</div>`).join('')}

  <!-- Footer -->
  <div style="background:#fff;border-radius:8px;border:1px solid #e8e8e8;padding:20px 24px;text-align:center;">
    <img src="${LOGO_URL}" alt="Picture Perfect Stays" style="height:44px;width:auto;margin-bottom:14px;display:block;margin-left:auto;margin-right:auto;" />
    <table cellpadding="0" cellspacing="0" border="0" style="margin:0 auto 8px;">
      <tr>
        <td style="padding:0 12px;vertical-align:middle;text-align:center;">
          <a href="${WEBSITE_URL}" style="color:#406A94;text-decoration:none;font-size:13px;font-weight:500;">
            🌐 staypictureperfect.com
          </a>
        </td>
        <td style="color:#ccc;font-size:16px;vertical-align:middle;">·</td>
        <td style="padding:0 12px;vertical-align:middle;text-align:center;">
          <a href="${INSTAGRAM_URL}" style="display:inline-block;text-decoration:none;vertical-align:middle;">
            <img src="${INSTAGRAM_ICON_URL}" alt="Instagram" width="20" height="20" style="display:inline-block;vertical-align:middle;border:0;" />
            <span style="color:#E1306C;font-size:13px;font-weight:500;vertical-align:middle;margin-left:4px;">@pictureperfectstays</span>
          </a>
        </td>
      </tr>
    </table>
    <div style="font-size:11px;color:#bbb;">Daily automated report · <a href="mailto:chris@staypictureperfect.com" style="color:#bbb;">chris@staypictureperfect.com</a></div>
  </div>

</div></body></html>`;
}

// ─── Resend ───────────────────────────────────────────────────────────────────

async function sendEmail(html, subject) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: SEND_FROM, to: [SEND_TO], subject, html }),
  });
  const body = await r.json();
  if (!r.ok) throw new Error(`Resend ${r.status}: ${JSON.stringify(body)}`);
  return body;
}

// ─── Priority Action Board ────────────────────────────────────────────────────

async function fetchLastBookedDates() {
  const results = await Promise.all(
    PROPERTIES.map(p =>
      sb(`bookings?select=property_id,booked_at&property_id=eq.${p.id}&status=eq.active&order=booked_at.desc&limit=1`)
        .then(rows => ({ propId: p.id, booked_at: rows[0]?.booked_at ?? null }))
        .catch(() => ({ propId: p.id, booked_at: null }))
    )
  );
  const map = {};
  for (const r of results) map[r.propId] = r.booked_at;
  return map;
}

// Generate the "because" explanation for a pricing alert — used in the Action Board
function alertBecause(a) {
  const ptsAbove = a.mktP50 > 0 ? Math.round((a.avgPrice / a.mktP50 - 1) * 100) : 0;
  const occStr   = a.propOcc != null && a.mktOcc != null ? ` Your occupancy ${a.propOcc}% vs market ${a.mktOcc}%.` : '';
  const isOccGap = a.propOcc != null && a.mktOcc != null && a.mktOcc > 0 && a.propOcc < a.mktOcc * 0.5;
  if (isOccGap) {
    return `Pricing is in line with market but occupancy (${a.propOcc}%) is less than half the market rate (${a.mktOcc}%). Check listing visibility, photos, and reviews — the price may not be the issue.`;
  }
  if (a.level === 'RED') {
    return `${a.nightsAboveP75} of ${a.totalNights} nights are above market p75 and occupancy is lagging.${occStr} At ${ptsAbove}% above market median (${fmt$(a.avgPrice)} vs ${fmt$(a.mktP50)}), bookings are going to lower-priced competitors. Reduce base price in PriceLabs now.`;
  }
  const pctAbove = Math.round(a.nightsAboveP75 / a.totalNights * 100);
  if (pctAbove > 20) {
    return `${a.nightsAboveP75} of ${a.totalNights} nights (${pctAbove}%) are above market p75.${occStr} At ${ptsAbove}% above market median (${fmt$(a.avgPrice)} vs ${fmt$(a.mktP50)}), advance bookings may be softening. Consider a price reduction in PriceLabs.`;
  }
  return `Average price ${ptsAbove}% above market median (${fmt$(a.avgPrice)} vs ${fmt$(a.mktP50)}).${occStr} A modest reduction in PriceLabs may improve booking velocity.`;
}

function buildPropertySummaries(plData, alertData, bookings, lastBookedMap, activity, mtd, tyBookings, lyBookings, paceMonths, hardcodedEvents, cachedEvents, taxRates, todayStr) {
  const now = new Date();
  const t14 = addDays(todayStr, 14);
  const t30 = addDays(todayStr, 30);

  const summaries = [];

  for (const prop of PROPERTIES) {
    const settings = alertData?.[prop.plId]?.settings ?? null;
    const prices   = plData?.[prop.plId] ?? {};
    const occ      = occupiedSet(bookings, prop.id);

    // ── Synopsis data ────────────────────────────────────────────────────────
    const propOcc30 = settings ? windowOcc(settings.occupancy_next_30, settings.occupancy_next_60, 30) : null;
    const mktOcc30  = settings ? windowOcc(settings.market_occupancy_next_30, settings.market_occupancy_next_60, 30) : null;
    const lastBooked   = lastBookedMap[prop.id];
    const daysSince    = lastBooked ? Math.floor((now - new Date(lastBooked)) / 86400000) : null;

    let openNext30 = 0;
    for (let i = 0; i < 30; i++) {
      const d = addDays(todayStr, i);
      if (!occ.has(d) && (prices[d]?.price ?? 0) > 0) openNext30++;
    }

    const synParts = [];
    if (propOcc30 != null && mktOcc30 != null)
      synParts.push(`Next 30 days: ${Math.round(propOcc30 * 100)}% occupied (market ${Math.round(mktOcc30 * 100)}%)`);
    if (daysSince === 0)       synParts.push('booking today');
    else if (daysSince === 1)  synParts.push('last booking yesterday');
    else if (daysSince != null) synParts.push(`last booking ${daysSince} days ago`);
    const synopsis = synParts.join(' · ');

    // ── Action items ─────────────────────────────────────────────────────────
    const actions = [];

    // 1. Cancellations for this property in last 24h
    for (const c of (activity.cancellations || [])) {
      if (c.property_id !== prop.id) continue;
      const nights = c.nights || Math.max(1, diffDays(c.arrival_date, c.departure_date));
      actions.push({
        level: 'red', anchor: '#section-activity', sectionLabel: 'Activity',
        text: `${c.guest_display_name || 'Guest'} cancelled ${fmtDate(c.arrival_date)}–${fmtDate(c.departure_date)} (${nights} night${nights !== 1 ? 's' : ''}, ${fmt$(c.gross_revenue)} lost). Dates are now open — re-list or contact your waitlist.`,
      });
    }

    // 2. Pricing alerts with full "because" explanation
    if (plData && alertData) {
      for (const a of computePropertyAlerts(prop, plData, alertData, bookings, todayStr)) {
        if (a.level === 'OK') continue;
        actions.push({
          level: a.level === 'RED' ? 'red' : 'yellow',
          anchor: '#section-pricing', sectionLabel: 'Pricing Alerts',
          text: `${a.window}: ${alertBecause(a)}`,
        });
      }
    }

    // 3. HIGH/VERY-HIGH events in next 30 days for this property
    // Suppress generic "Peak Season" events when a pricing alert already covers the analysis —
    // showing "elevate prices" alongside "you're above market, reduce prices" is contradictory.
    const hasPricingAlert = actions.some(a => a.level === 'red' || a.level === 'yellow');
    const seenEvt = new Set();
    for (const evt of [...hardcodedEvents, ...cachedEvents]) {
      if (evt.end_date < todayStr || evt.start_date > t30) continue;
      if (!['high', 'very-high'].includes((evt.impact || '').toLowerCase())) continue;
      if (PROP_MARKET[prop.id] !== evt.market) continue;
      if (hasPricingAlert && /peak season/i.test(evt.name)) continue;
      const key = `${evt.name}|${evt.start_date}`;
      if (seenEvt.has(key)) continue;
      seenEvt.add(key);
      const dStr = evt.end_date === evt.start_date ? fmtDate(evt.start_date) : `${fmtDate(evt.start_date)}–${fmtDate(evt.end_date)}`;
      actions.push({
        level: 'event', anchor: '#section-events', sectionLabel: 'Events',
        text: `${evt.name} ${dStr} (${(evt.impact || '').replace('-', ' ')} impact) — verify pricing is elevated for these dates.`,
      });
    }

    // 4. No new bookings in >21 days with open nights
    if (plData && daysSince != null && daysSince >= 21 && openNext30 > 0) {
      actions.push({
        level: 'watch', anchor: '#section-pricing', sectionLabel: 'Pricing',
        text: `No new bookings in ${daysSince} days with ${openNext30} open night${openNext30 !== 1 ? 's' : ''} available in the next 30 days. Check listing rank, photos, and reviews across all channels.`,
      });
    }

    // 5. Gap nights in next 14 days — top one by value + count
    const nearGaps = gapNights(bookings, prop.id, todayStr, t14);
    if (nearGaps.length > 0) {
      const top  = [...nearGaps].sort((a, b) => ((b.baseRentPerNight || 0) * b.nights) - ((a.baseRentPerNight || 0) * a.nights))[0];
      const dStr = top.nights === 1 ? fmtDate(top.dates[0]) : `${fmtDate(top.dates[0])}–${fmtDate(top.dates[top.dates.length - 1])}`;
      const val  = top.baseRentPerNight ? ` ~${fmt$(Math.round(top.baseRentPerNight * top.nights))}` : '';
      const more = nearGaps.length > 1 ? ` (+${nearGaps.length - 1} more gap${nearGaps.length > 2 ? 's' : ''} this week)` : '';
      actions.push({
        level: 'gap', anchor: '#section-gaps', sectionLabel: 'Open Nights',
        text: `${top.nights}-night gap ${dStr}${val} — contact ${top.prevGuest || 'checkout guest'} or ${top.nextGuest || 'checkin guest'} to fill.${more}`,
      });
    }

    // 6. Booking pace >20% behind LY for first pace month
    const pm = paceMonths[0];
    let tyRev = 0, lyRev = 0;
    for (const b of tyBookings) { if (b.property_id === prop.id) tyRev += prorateToMonth(b, pm.start, pm.end).revenue; }
    for (const b of lyBookings) { if (b.property_id === prop.id) lyRev += prorateToMonth(b, pm.start, pm.end).revenue; }
    if (lyRev > 200 && tyRev < lyRev * 0.80) {
      const pct = Math.round((1 - tyRev / lyRev) * 100);
      actions.push({
        level: 'watch', anchor: '#section-pace', sectionLabel: 'Booking Pace',
        text: `${pm.label} bookings are ${pct}% behind last year (${fmt$(Math.round(tyRev))} vs ${fmt$(Math.round(lyRev))}). Consider a promotion or price adjustment to stimulate demand.`,
      });
    }

    // ── Status ───────────────────────────────────────────────────────────────
    const hasRed   = actions.some(a => a.level === 'red');
    const hasWatch = actions.some(a => ['yellow', 'watch', 'gap', 'event'].includes(a.level));
    summaries.push({ prop, synopsis, actions, status: hasRed ? 'red' : hasWatch ? 'yellow' : 'green' });
  }

  // ── Portfolio note (MTD) ──────────────────────────────────────────────────
  const curRevTotal = mtd.cur.reduce((s, b) => s + (Number(b.gross_revenue) || 0), 0);
  const lyRevTotal  = mtd.ly.reduce((s, b) => s + (Number(b.gross_revenue) || 0), 0);
  let portfolioNote = null;
  if (lyRevTotal > 200 && curRevTotal < lyRevTotal * 0.85) {
    const pct = Math.round((1 - curRevTotal / lyRevTotal) * 100);
    portfolioNote = `Portfolio MTD: ${fmt$(Math.round(curRevTotal))} vs ${fmt$(Math.round(lyRevTotal))} last year (${pct}% behind). See MTD Revenue section for property breakdown.`;
  }

  return { summaries, portfolioNote };
}

function sectionPriorityBoard({ summaries, portfolioNote }, todayStr) {
  const boldDollars = str => str.replace(/\$[\d,]+(?:\.\d+)?/g, m => `<strong>${m}</strong>`);

  const STATUS = {
    red:    { emoji: '🔴', color: '#c0392b', border: '#e74c3c', headerBg: '#fff0f0', cardBorder: '#fcc' },
    yellow: { emoji: '🟡', color: '#d97706', border: '#d97706', headerBg: '#fffbf0', cardBorder: '#fde68a' },
    green:  { emoji: '🟢', color: '#1a7f5a', border: '#1a7f5a', headerBg: '#f0faf5', cardBorder: '#a7f3d0' },
  };
  const ACTION_COLOR = { red: '#c0392b', yellow: '#d97706', event: '#b45309', gap: '#0369a1', watch: '#555' };

  const boardHeader = `<h2 style="font-size:15px;font-weight:700;color:#1a1a2e;margin:0 0 8px;padding-bottom:10px;border-bottom:2px solid #c5d9ee;">⚡ Today's Action Board — ${fmtDateL(todayStr)}</h2>`;
  const legend      = `<p style="font-size:11px;color:#666;margin:0 0 14px;padding:0;">🔴 Needs Attention &nbsp;·&nbsp; 🟡 Watch &nbsp;·&nbsp; 🟢 On Track</p>`;

  const cards = summaries.map(({ prop, synopsis, actions, status }) => {
    const s = STATUS[status];
    const header = `<table cellpadding="0" cellspacing="0" border="0" style="width:100%;background:${s.headerBg};border-bottom:1px solid ${s.cardBorder};"><tr>
      <td style="padding:8px 14px;font-weight:700;font-size:13px;color:${s.color};">${s.emoji} ${prop.name}</td>
      <td style="padding:8px 14px;text-align:right;font-size:11px;color:#888;">${prop.location}</td>
    </tr></table>`;
    const syn = synopsis ? `<div style="padding:6px 14px;background:#fafafa;border-bottom:1px solid #f0f0f0;font-size:12px;color:#666;">${synopsis}</div>` : '';
    let body;
    if (actions.length === 0) {
      body = `<div style="padding:10px 14px;font-size:13px;color:#1a7f5a;">✓ No actions needed today.</div>`;
    } else {
      const rows = actions.map((a, i) => {
        const c    = ACTION_COLOR[a.level] || '#555';
        const jump = `<a href="${a.anchor}" style="font-size:11px;color:#406A94;text-decoration:none;font-weight:600;margin-left:10px;white-space:nowrap;">↓ ${a.sectionLabel}</a>`;
        const sep  = i < actions.length - 1 ? 'border-bottom:1px solid #f3f4f6;' : '';
        return `<div style="padding:8px 0;${sep}font-size:13px;line-height:1.5;color:${c};">→ ${boldDollars(a.text)}${jump}</div>`;
      }).join('');
      body = `<div style="padding:4px 14px 10px;">${rows}</div>`;
    }
    return `<div style="margin-bottom:10px;border-radius:8px;overflow:hidden;border:1px solid ${s.cardBorder};border-left:4px solid ${s.border};">${header}${syn}${body}</div>`;
  }).join('');

  const portHtml = portfolioNote
    ? `<div style="margin-top:4px;padding:10px 14px;background:#f8f9fa;border-radius:6px;border-left:3px solid #9ca3af;font-size:12px;color:#555;">📊 ${boldDollars(portfolioNote)} <a href="#section-mtd" style="font-size:11px;color:#406A94;text-decoration:none;font-weight:600;margin-left:8px;">↓ MTD Revenue</a></div>`
    : '';

  return `<div style="background:#eef4fb;border-radius:10px;padding:18px 24px;margin-bottom:16px;border:1px solid #c5d9ee;border-left:4px solid #406A94;">
  ${boardHeader}${legend}${cards}${portHtml}
</div>`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

// Sample PriceLabs data for preview mode — realistic demo prices
function buildSamplePlData(bookings, todayStr) {
  const DEMAND_POOL = ['Low Demand','Low Demand','Normal Demand','Normal Demand','High Demand','Very High Demand'];
  const BASE = { 5: 260, 6: 195, 7: 105, 8: 110 };
  const data = {};
  for (const p of PROPERTIES) {
    data[p.plId] = {};
    const occ = occupiedSet(bookings, p.id);
    for (let i = 0; i < 90; i++) {
      const d = addDays(todayStr, i);
      if (occ.has(d)) continue;
      const dow = new Date(d + 'T00:00:00Z').getUTCDay();
      const isWknd = dow === 5 || dow === 6;
      const base = BASE[p.id] * (isWknd ? 1.3 : 1) * (1 + i / 400);
      const demand = DEMAND_POOL[Math.floor(Math.random() * DEMAND_POOL.length)];
      const hasOverride = Math.random() < 0.12;
      data[p.plId][d] = {
        price: Math.round(base),
        user_price: hasOverride ? Math.round(base * 1.1) : -1,
        demand_desc: demand,
        min_stay: isWknd ? 3 : 2,
        unbookable: demand === 'Low Demand' && !isWknd && Math.random() < 0.15 ? 1 : 0,
        booking_status: '',
      };
    }
  }
  return data;
}

async function main() {
  const todayStr = today();
  const t90 = addDays(todayStr, 90);
  const PREVIEW_OUT = ENV.PREVIEW_OUT;

  console.log(`Daily report for ${todayStr}${PREVIEW_OUT ? ' [PREVIEW MODE]' : ''}`);

  const paceMonths = getPaceMonths(todayStr);
  const cachedEvents = fetchEventsCache();
  const [activity, mtd, bookings, taxRates, paceData, forecastData, lastBookedMap] = await Promise.all([
    fetchRecentActivity(),
    fetchMTDRevenue(todayStr),
    fetchBookings90(todayStr, t90),
    fetchTaxRates(),
    fetchBookingPaceData(paceMonths, todayStr),
    fetchRevenueForecastData(paceMonths, todayStr),
    fetchLastBookedDates(),
  ]);
  const { tyBookings, lyBookings } = paceData;
  const { tyBlocked, histActive, histBlocked } = forecastData;

  console.log(`  Bookings (90d): ${bookings.length} | New: ${activity.newBookings.length} | Cancelled: ${activity.cancellations.length} | MTD: ${mtd.cur.length}`);
  console.log(`  Pace months: ${paceMonths.map(m => m.label).join(', ')} | TY: ${tyBookings.length} bkgs | LY: ${lyBookings.length} bkgs`);
  console.log(`  Forecast: ${histActive.length} historical bookings | ${tyBlocked.length} current-yr blocks`);

  // PriceLabs: try REST API first, then file fallback, then preview sample
  let plData = loadPriceLabsFile();
  if (!plData && PRICELABS_KEY) {
    console.log('  Fetching PriceLabs prices from API...');
    try { plData = await fetchPriceLabsData(todayStr, t90); }
    catch (e) { console.warn('  PriceLabs API fetch failed:', e.message); }
  }
  if (!plData && PREVIEW_OUT) {
    console.log('  PriceLabs data: generating sample data for preview');
    plData = buildSamplePlData(bookings, todayStr);
  }
  console.log(`  PriceLabs data: ${plData ? 'loaded (' + Object.keys(plData).length + ' listings)' : 'not available'}`);

  // Snapshot PriceLabs prices to Supabase for historical analysis
  if (plData && PRICELABS_KEY && !PREVIEW_OUT) {
    try {
      const n = await snapshotPriceLabsData(plData, new Date().toISOString());
      console.log(`  ✓ pricing_snapshots: ${n} rows upserted`);
    } catch (e) { console.warn('  pricing_snapshots failed (non-fatal):', e.message); }
  }

  // Pricing alerts: listing settings + neighborhood market percentiles
  let alertData = null;
  if (PRICELABS_KEY && plData) {
    console.log('  Fetching pricing alert data (settings + market percentiles)...');
    try { alertData = await fetchPricingAlertData(); }
    catch (e) { console.warn('  Pricing alert fetch failed:', e.message); }
  }

  // Save RED/YELLOW alerts to pricing_actions for portal approval workflow
  if (alertData && plData && !PREVIEW_OUT) {
    try {
      const n = await savePricingActions(plData, alertData, bookings, todayStr);
      console.log(`  ✓ pricing_actions: ${n} new action(s) written`);
    } catch (e) { console.warn('  pricing_actions write failed (non-fatal):', e.message); }
  }

  const hardcodedEvents = getHardcodedEvents(todayStr);
  console.log(`  Events: ${hardcodedEvents.length} hardcoded + ${cachedEvents.length} from cache`);

  // Priority Action Board: per-property summary with action items
  console.log('  Building Priority Action Board...');
  const { summaries, portfolioNote } = buildPropertySummaries(plData, alertData, bookings, lastBookedMap, activity, mtd, tyBookings, lyBookings, paceMonths, hardcodedEvents, cachedEvents, taxRates, todayStr);
  const priorityBoardHtml = sectionPriorityBoard({ summaries, portfolioNote }, todayStr);
  const totalActions = summaries.reduce((n, s) => n + s.actions.length, 0);
  console.log(`  ✓ Priority Action Board: ${totalActions} action items across ${summaries.length} properties`);

  const sections = [
    sectionMTD(mtd, todayStr),
    sectionActivity(activity),
    sectionPricingAlerts(plData, alertData, bookings, todayStr),
    sectionSmartEvents(hardcodedEvents, cachedEvents, plData, histActive, todayStr),
    sectionOpenNights(bookings, todayStr, taxRates),
    sectionBookingPace(tyBookings, lyBookings, paceMonths, todayStr),
    sectionRevenueForecast(paceMonths, todayStr, tyBookings, tyBlocked, histActive, histBlocked, plData),
    sectionPrices(bookings, plData, todayStr, alertData),
  ];

  const html = buildEmail(todayStr, sections, priorityBoardHtml);
  const subject = `PPS Daily Report · ${fmtDateL(todayStr)}`;

  if (PREVIEW_OUT) {
    const { writeFileSync } = await import('fs');
    writeFileSync(PREVIEW_OUT, html);
    console.log(`  ✓ Preview written to: ${PREVIEW_OUT}`);
    return;
  }

  console.log('  Sending via Resend...');
  const result = await sendEmail(html, subject);
  console.log(`  ✓ Sent! ID: ${result.id}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
