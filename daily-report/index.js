#!/usr/bin/env node
// Daily Revenue Report — Picture Perfect Stays
// Run: node index.js
// Required env: SUPABASE_URL, SUPABASE_SERVICE_KEY, RESEND_API_KEY
// Optional env: PRICELABS_API_KEY (enables pricing section — key in ~/.claude/settings.json)

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Credentials ─────────────────────────────────────────────────────────────

function loadEnv() {
  const env = { ...process.env };
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
    try {
      const localPath = join(__dirname, 'settings.json');
      const globalPath = join(homedir(), '.claude', 'settings.json');
      const settingsPath = existsSync(localPath) ? localPath : globalPath;
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
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
function computePropertyAlerts(prop, plData, alertData, todayStr) {
  const propAlertData = alertData?.[prop.plId];
  if (!propAlertData?.settings || !propAlertData?.market) return [];

  const { settings, market } = propAlertData;
  const bedroomCount = settings.no_of_bedrooms ?? 1;
  const percentiles  = parseMarketPercentiles(market, bedroomCount);
  const prices       = plData?.[prop.plId] ?? {};

  const windows = [
    {
      label:    'Next 30 days',
      startDay: 0, endDay: 30,
      propOcc:  windowOcc(settings.occupancy_next_30, settings.occupancy_next_60, 30),
      mktOcc:   windowOcc(settings.market_occupancy_next_30, settings.market_occupancy_next_60, 30),
    },
    {
      label:    'Days 31–60',
      startDay: 30, endDay: 60,
      propOcc:  windowOcc(settings.occupancy_next_30, settings.occupancy_next_60, 60),
      mktOcc:   windowOcc(settings.market_occupancy_next_30, settings.market_occupancy_next_60, 60),
    },
    {
      label:    'Days 61–90',
      startDay: 60, endDay: 90,
      propOcc:  null, // not available from API
      mktOcc:   null,
    },
  ];

  const alerts = [];

  for (const win of windows) {
    // Collect all dates in this window that have a price (booked or open)
    const windowDates = [];
    for (let i = win.startDay; i < win.endDay; i++) windowDates.push(addDays(todayStr, i));

    const datesWithPrice = windowDates.filter(d => prices[d]?.price != null && prices[d].price > 0);
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
      action = `Review and reduce pricing for ${win.label}. Currently ${ptsAbove}% above market median.`;
    } else if (level === 'RED' && reason === 'occupancy_gap') {
      action = 'Pricing may not be the issue — check listing rank and reviews on Airbnb/VRBO.';
    } else if (reason === 'overpriced') {
      action = `Monitor — ${nightsAboveP75} of ${datesWithPrice.length} nights above 75th percentile.`;
    } else {
      action = `Monitor — avg price ${ptsAbove}% above market median.`;
    }

    alerts.push({
      window: win.label, level: level || 'OK',
      avgPrice: Math.round(avgPrice),
      mktP50:   Math.round(avgP50),
      nightsAboveP75, totalNights: datesWithPrice.length,
      propOcc: propOcc != null ? Math.round(propOcc * 100) : null,
      mktOcc:  mktOcc  != null ? Math.round(mktOcc  * 100) : null,
      action,
    });
  }

  return alerts;
}

function sectionPricingAlerts(plData, alertData, todayStr) {
  let html = `<h2 style="${H2}">🚨 Pricing Alerts</h2>`;

  if (!PRICELABS_KEY || !alertData || !plData) {
    return html + `<p style="color:#888;font-style:italic;font-size:13px;">PriceLabs data required for pricing alerts.</p>`;
  }

  const RED_BG = '#fff0f0', RED_COLOR = '#c0392b', RED_BADGE = '#fde8e8';
  const YLW_BG = '#fffbf0', YLW_COLOR = '#d97706', YLW_BADGE = '#fef3c7';
  const GRN_COLOR = '#1a7f5a';

  // Collect rows for ALL properties × ALL windows (not just alerting ones)
  const allRows = [];
  for (const prop of PROPERTIES) {
    const propRows = computePropertyAlerts(prop, plData, alertData, todayStr);
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
      <th style="${TH}text-align:right;">Nights &gt;p75</th>
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

  return `<h2 style="${H2}">📊 Month-to-Date Revenue — ${monthLabel}</h2>
  <table style="width:100%;border-collapse:collapse;font-size:13px;">
    <tr style="background:#f8f9fa;">
      <th style="${TH}">Property</th><th style="${TH}text-align:right;">This Month</th>
      <th style="${TH}text-align:right;">Same Pd LY</th><th style="${TH}text-align:right;">YoY</th>
      <th style="${TH}text-align:right;">Volume</th>
    </tr>${rows}
  </table>
  <p style="font-size:11px;color:#aaa;margin:8px 0 0;">Bookings with arrival date in ${monthLabel} through ${fmtDate(todayStr)}. Prior year = same ${Math.round(diffDays(mtd.lyStart, addDays(todayStr,-365))+1)}-day window.</p>`;
}

function sectionActivity({ newBookings, cancellations }) {
  if (!newBookings.length && !cancellations.length) {
    return `<h2 style="${H2}">🔔 Activity — Last 24 Hours</h2>
    <p style="color:#888;margin:8px 0;font-style:italic;">No new bookings or cancellations in the last 24 hours.</p>`;
  }
  let html = `<h2 style="${H2}">🔔 Activity — Last 24 Hours</h2>`;
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
  let html = `<h2 style="${H2}">📅 Open Nights & Gap Opportunities</h2>`;

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

function sectionPrices(bookings, plData, todayStr) {
  const t90 = addDays(todayStr, 90);
  let html = `<h2 style="${H2}">💰 Pricing — Open Days (Next 90)</h2>`;

  if (!plData) {
    html += `<p style="color:#888;font-style:italic;font-size:13px;">
      PriceLabs prices unavailable right now — this typically happens during their overnight recalculation (usually complete by 6am AZ time). The 7am scheduled send will have full pricing data.
    </p>`;
    return html;
  }

  for (const p of PROPERTIES) {
    const open = openDates(bookings, p.id, todayStr, t90);
    const propPrices = plData[p.plId] || {};

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
        <span style="font-size:12px;color:#888;">${open.length} open days · ${p.minPrice ? `min ${fmt$(p.minPrice)}` : 'no min price'}</span>
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
        const urgencyNote = pricingUrgencyNote(daysOut, r.demand_desc, r.price, p.minPrice);
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

function buildEmail(todayStr, sections) {
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

  const [activity, mtd, bookings, taxRates] = await Promise.all([
    fetchRecentActivity(),
    fetchMTDRevenue(todayStr),
    fetchBookings90(todayStr, t90),
    fetchTaxRates(),
  ]);

  console.log(`  Bookings (90d): ${bookings.length} | New: ${activity.newBookings.length} | Cancelled: ${activity.cancellations.length} | MTD: ${mtd.cur.length}`);

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

  // Pricing alerts: listing settings + neighborhood market percentiles
  let alertData = null;
  if (PRICELABS_KEY && plData) {
    console.log('  Fetching pricing alert data (settings + market percentiles)...');
    try { alertData = await fetchPricingAlertData(); }
    catch (e) { console.warn('  Pricing alert fetch failed:', e.message); }
  }

  const sections = [
    sectionMTD(mtd, todayStr),
    sectionActivity(activity),
    sectionOpenNights(bookings, todayStr, taxRates),
    sectionPrices(bookings, plData, todayStr),
    sectionPricingAlerts(plData, alertData, todayStr),
  ];

  const html = buildEmail(todayStr, sections);
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
