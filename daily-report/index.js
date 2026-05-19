#!/usr/bin/env node
// Daily Revenue Report — Picture Perfect Stays
// Run directly:  node index.js
// With PriceLabs: PRICELABS_DATA_FILE=/tmp/pl.json node index.js
// Required env:  SUPABASE_URL, SUPABASE_SERVICE_KEY, RESEND_API_KEY
// Optional env:  PRICELABS_DATA_FILE (path to JSON written by the CoWork routine)

import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ─── Credentials ─────────────────────────────────────────────────────────────

function loadEnv() {
  const env = { ...process.env };
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
    try {
      const settings = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8'));
      if (settings.env) Object.assign(env, settings.env);
    } catch {}
  }
  return env;
}

const ENV = loadEnv();
const SUPABASE_URL = ENV.SUPABASE_URL;
const SUPABASE_KEY = ENV.SUPABASE_SERVICE_KEY;
const RESEND_KEY = ENV.RESEND_API_KEY;
const PL_DATA_FILE = ENV.PRICELABS_DATA_FILE;

if (!SUPABASE_URL || !SUPABASE_KEY) { console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY'); process.exit(1); }
if (!RESEND_KEY) { console.error('Missing RESEND_API_KEY'); process.exit(1); }

// ─── Config ──────────────────────────────────────────────────────────────────

const SEND_TO = 'chris@staypictureperfect.com';
const SEND_FROM = 'reports@mail.staypictureperfect.com';

// targetPct: the market percentile this property targets (for color-coding demand vs price)
// Emerald Views targets p75-p90 (premium 1BR with 2BA)
const PROPERTIES = [
  { id: 5,  plId: '471179', name: 'Emerald Views',          location: 'Panama City Beach, FL', minPrice: 105, targetPct: 75, color: '#1a7f5a' },
  { id: 6,  plId: '471178', name: 'Enchanted Getaway',      location: 'Sevierville, TN',        minPrice: null, targetPct: 50, color: '#5b4fcf' },
  { id: 7,  plId: '471181', name: 'Musical Oasis',          location: 'Scottsdale, AZ',         minPrice: 90,  targetPct: 50, color: '#c0392b' },
  { id: 8,  plId: '471180', name: 'Travelers Paradise',     location: 'Scottsdale, AZ',         minPrice: 100, targetPct: 50, color: '#d35400' },
];

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
    `bookings?select=id,property_id,guest_display_name,arrival_date,departure_date,nights,gross_revenue,net_revenue,booking_channel,booked_at`
    + `&status=in.(active,blocked)&arrival_date=lt.${toDate}&departure_date=gt.${fromDate}`
    + `&order=arrival_date.asc`
  );
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

// ─── PriceLabs Data (supplied externally by CoWork routine) ───────────────────
// Format: { "471179": { "2026-05-27": { price, user_price, demand_desc, min_stay, unbookable, booking_status }, ... }, ... }

function loadPriceLabsData() {
  if (!PL_DATA_FILE) return null;
  try {
    return JSON.parse(readFileSync(PL_DATA_FILE, 'utf8'));
  } catch (e) {
    console.warn('Could not read PRICELABS_DATA_FILE:', e.message);
    return null;
  }
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
      gaps.push({ nights, dates, checkOut: gStart, checkIn: gEnd,
        prevGuest: sorted[i].guest_display_name, nextGuest: sorted[i+1].guest_display_name });
    }
  }
  return gaps;
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

function sectionOpenNights(bookings, todayStr) {
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
      html += `<div style="margin-top:8px;padding:8px 12px;background:#fff8e1;border-radius:6px;border-left:3px solid #f39c12;">
        <div style="font-size:12px;font-weight:700;color:#e67e22;margin-bottom:4px;">⚡ Gap Nights — outreach opportunity</div>`;
      for (const g of gaps) {
        html += `<div style="font-size:13px;padding:3px 0;color:#555;">
          <strong>${g.nights === 1 ? '1 night' : `${g.nights} nights`}:</strong>
          ${g.dates.map(fmtDateL).join(', ')}
          <span style="color:#999;font-size:12px;"> (prev checkout ${fmtDate(g.checkOut)} → next checkin ${fmtDate(g.checkIn)})</span>
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
      PriceLabs data not available. To enable this section, the CoWork routine supplies price data via PRICELABS_DATA_FILE.
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
        const rowBg = isUnbookable ? '#fffbf3' : '';
        html += `<tr style="border-bottom:1px solid #f0f0f0;background:${rowBg}">
          <td style="padding:5px 8px;">${fmtDateL(r.date)}</td>
          <td style="padding:5px 8px;text-align:right;font-weight:600;">${fmt$(r.price)}</td>
          <td style="padding:5px 8px;text-align:right;${isOverride?'font-weight:600;color:#2980b9;':'color:#ccc;'}">${isOverride ? fmt$(r.user_price) : '—'}</td>
          <td style="padding:5px 8px;text-align:right;color:#666;">${r.min_stay ?? '—'}</td>
          <td style="padding:5px 8px;">${r.demand_desc ? badge(r.demand_desc, demColor) : ''}</td>
          <td style="padding:5px 8px;font-size:11px;color:#e67e22;">${isUnbookable ? '⚠ unbookable' : ''}</td>
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

function buildEmail(todayStr, sections) {
  const timeStr = new Date().toLocaleString('en-US', {
    timeZone: 'America/Phoenix', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Daily Revenue Report</title></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#222;">
<div style="max-width:680px;margin:0 auto;padding:20px 16px;">

  <div style="background:linear-gradient(135deg,#1a1a2e,#16213e);border-radius:10px;padding:24px 28px;margin-bottom:16px;color:#fff;">
    <div style="font-size:11px;text-transform:uppercase;letter-spacing:1.5px;color:#7a9bbf;margin-bottom:6px;">Picture Perfect Stays</div>
    <div style="font-size:22px;font-weight:700;">Daily Revenue Report</div>
    <div style="font-size:13px;color:#7a9bbf;margin-top:4px;">${fmtDateL(todayStr)} · ${timeStr}</div>
  </div>

  ${sections.map(s => `<div style="${SECTION}">${s}</div>`).join('')}

  <div style="text-align:center;padding:12px;font-size:11px;color:#bbb;">
    Picture Perfect Stays · Daily automated report · <a href="mailto:chris@staypictureperfect.com" style="color:#bbb;">chris@staypictureperfect.com</a>
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

async function main() {
  const todayStr = today();
  const t90 = addDays(todayStr, 90);

  console.log(`Daily report for ${todayStr}`);

  const [activity, mtd, bookings] = await Promise.all([
    fetchRecentActivity(),
    fetchMTDRevenue(todayStr),
    fetchBookings90(todayStr, t90),
  ]);

  console.log(`  Bookings (90d): ${bookings.length} | New: ${activity.newBookings.length} | Cancelled: ${activity.cancellations.length} | MTD: ${mtd.cur.length}`);

  const plData = loadPriceLabsData();
  console.log(`  PriceLabs data: ${plData ? 'loaded from ' + PL_DATA_FILE : 'not available'}`);

  const sections = [
    sectionMTD(mtd, todayStr),
    sectionActivity(activity),
    sectionOpenNights(bookings, todayStr),
    sectionPrices(bookings, plData, todayStr),
  ];

  const html = buildEmail(todayStr, sections);
  const subject = `PPS Daily Report · ${fmtDateL(todayStr)}`;

  console.log('  Sending via Resend...');
  const result = await sendEmail(html, subject);
  console.log(`  ✓ Sent! ID: ${result.id}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
