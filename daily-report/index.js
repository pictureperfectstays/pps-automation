#!/usr/bin/env node
// Daily Revenue Report — Picture Perfect Stays
// Run: node index.js
// Required env: SUPABASE_URL, SUPABASE_SERVICE_KEY, RESEND_API_KEY
// Optional env: PRICELABS_API_KEY (enables pricing section — key in ~/.claude/settings.json)

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { getHardcodedEvents, MARKETS } from './events-calendar.js';
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
const PL_DATA_FILE = ENV.PRICELABS_DATA_FILE; // fallback: load from file if set (local runs only)
const IS_CI = ENV.GITHUB_ACTIONS === 'true';
// Run log identity: GITHUB_REF is e.g. refs/heads/main; local runs log as 'local'
const GIT_REF       = ENV.GITHUB_REF || 'local';
const TRIGGER_EVENT = ENV.GITHUB_EVENT_NAME || 'local';
const GITHUB_RUN_ID = ENV.GITHUB_RUN_ID || null;
const FORCE_SEND    = ENV.FORCE_SEND === 'true'; // workflow_dispatch input "force"
const MAIN_REF      = 'refs/heads/main';

if (!SUPABASE_URL || !SUPABASE_KEY) { console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY'); process.exit(1); }
if (!RESEND_KEY) { console.error('Missing RESEND_API_KEY'); process.exit(1); }

// ─── Config ──────────────────────────────────────────────────────────────────

const SEND_TO = 'chris@staypictureperfect.com';
const SEND_FROM = 'reports@mail.staypictureperfect.com';
const LOGO_URL = 'https://vzozyzkaovegwfdmbcxg.supabase.co/storage/v1/object/public/assets/logo.png';
const INSTAGRAM_ICON_URL = 'https://vzozyzkaovegwfdmbcxg.supabase.co/storage/v1/object/public/assets/instagram-icon.png';
const WEBSITE_URL = 'https://www.staypictureperfect.com';
const INSTAGRAM_URL = 'https://www.instagram.com/pictureperfectstays';

// Live properties, loaded from Supabase at the start of main() by loadProperties().
// Each: { id, plId, name, fullName, city, state, location, market, owned, color,
//         targetLowPct, targetHighPct }
let PROPERTIES = [];

// Badge colors: the original four keep theirs; any other property takes the
// next palette color in ID order.
const PROPERTY_COLOR = { 5: '#668CB3', 6: '#D96666', 7: '#737373', 8: '#65AD89' };
const EXTRA_COLORS   = ['#8E6BB8', '#C98A3D', '#3D9CA8', '#B8607E', '#6B8E3D'];

// ─── Gap Night Offers ─────────────────────────────────────────────────────────

// Gap night offer = the adjacent guest's own stay rent per night × this
// (rent only, after rent discounts, no cleaning). Not PriceLabs' price for the
// open night, which already carries a last-minute discount.
const GAP_OFFER_FACTOR = 0.75;

// Stripe processing on charges collected outside the channel (Chris's
// understanding of his rate). Belongs in the portal's payment-flow settings
// later (Build B); kept here in one place until then.
const STRIPE_PCT   = 0.029;
const STRIPE_FIXED = 0.30;

// What you keep from a gap night offer, by the adjacent guest's channel.
// The stay rate already includes each channel's markup, so no markup math here.
// offer = rent for the night; tax = tax amount on it (guest pays offer + tax).
// Returns null when the night isn't offered through that channel.
// The one place gap-night fee rates live, so Build B can swap the source.
function gapNetByChannel(offer, tax, channel) {
  const stripe = STRIPE_PCT * (offer + tax) + STRIPE_FIXED;
  switch (channelKind(channel)) {
    case 'airbnb':  return offer * (1 - 0.155);       // special offer through Airbnb, host-only fee
    case 'vrbo':    return offer - 0.12 * offer - stripe; // night added in OwnerRez: Vrbo 12% of offer + Stripe on the full charge
    case 'direct':  return offer - stripe;
    default:        return null;                       // Booking.com and anything unknown: not offered (Build B)
  }
}

function channelKind(channel) {
  const c = (channel || '').toLowerCase();
  if (c.includes('airbnb')) return 'airbnb';
  if (c.includes('vrbo') || c.includes('homeaway')) return 'vrbo';
  if (c.includes('booking.com') || c === 'booking') return 'booking';
  if (c === '' || c.includes('picture perfect') || c.includes('direct') || c.includes('guesty')) return 'direct';
  return 'other';
}

// Insurance-paid stays ("Insurance Claim - …", rent line "Paid by Insurance…")
// are real bookings and count everywhere except gap offers. Checked before the
// owner-block logic, so their empty channel never makes them look like a block.
function isInsuranceStay(b) {
  if (/^\s*insurance claim/i.test(b.guest_display_name || '')) return true;
  return (b.charges_json || []).some(c => /paid by insurance/i.test(c.description || ''));
}
const isOwnerBlock = b => !isInsuranceStay(b) && b.status === 'blocked';

// Channel as shown in the email
function channelLabel(b) {
  if (isInsuranceStay(b)) return 'Insurance';
  if (b.status === 'blocked') return 'Owner block';
  return b.booking_channel || 'Direct';
}

// ─── Date Helpers ─────────────────────────────────────────────────────────────

const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const diffDays = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
// "Today" is always the Arizona date (America/Phoenix, no DST), never the UTC date
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Phoenix' }).format(new Date());
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

// Page through a Supabase read until done (PostgREST caps responses at 1000 rows)
async function sbAll(path) {
  const PAGE = 1000;
  const rows = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await sb(`${path}&limit=${PAGE}&offset=${offset}`);
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}

async function sbWrite(method, path, body, prefer = 'return=minimal') {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json', Prefer: prefer,
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Supabase ${method} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return prefer.includes('representation') ? r.json() : null;
}

// ─── Run Status ───────────────────────────────────────────────────────────────
// failures: a step failed or returned partial data. Shown in the banner at the
// top of the email; the run then exits 1 after sending, so the workflow goes red.
// warnings: worth knowing but not a failure (e.g. yesterday's report missing).
// Shown in the same banner; they don't change the exit code.

const failures = [];
const warnings = [];
// Exact repeats are dropped (some checks run once per section that uses the data)
function recordFailure(step, detail) {
  detail = String(detail).slice(0, 300);
  if (failures.some(f => f.step === step && f.detail === detail)) return;
  failures.push({ step, detail });
  console.warn(`  ✗ FAILED: ${step}: ${detail}`);
}
function recordWarning(step, detail) {
  detail = String(detail).slice(0, 300);
  if (warnings.some(w => w.step === step && w.detail === detail)) return;
  warnings.push({ step, detail });
  console.warn(`  ⚠ ${step}: ${detail}`);
}

// Run a data step; on error record the failure and return null so the
// section that needs it can say the data is unavailable.
async function step(name, fn) {
  try { return await fn(); }
  catch (e) { recordFailure(name, e.message); return null; }
}

// ─── Properties ───────────────────────────────────────────────────────────────

// Market for a property, from its city (events and seasonality notes are per market)
const marketForCity = city => Object.values(MARKETS).find(m => m.toLowerCase() === (city || '').trim().toLowerCase()) || null;

// Live properties: same rule as the portal (onboarding_status 'live', active,
// OwnerRez ID set). Owned vs. Managed mirrors the portal's rule in
// picture-perfect-stays-portal/admin-users.html:809-818: a property is Owned
// when an admin account is linked to it in property_owners, otherwise Managed.
async function loadProperties() {
  const rows = await sb(
    'properties?select=id,name,report_short_name,city,state,pricelabs_listing_id,'
    + 'price_target_low_pct,price_target_high_pct,property_owners(owners(is_admin))'
    + '&onboarding_status=eq.live&is_active=eq.true&ownerrez_property_id=not.is.null&order=id'
  );
  let extra = 0;
  const props = rows.map(r => ({
    id:            r.id,
    plId:          r.pricelabs_listing_id ? String(r.pricelabs_listing_id) : null,
    name:          r.report_short_name || r.name,
    fullName:      r.name,
    city:          r.city,
    state:         r.state,
    location:      [r.city, r.state].filter(Boolean).join(', '),
    market:        marketForCity(r.city),
    owned:         (r.property_owners || []).some(po => po.owners?.is_admin),
    color:         PROPERTY_COLOR[r.id] || EXTRA_COLORS[extra++ % EXTRA_COLORS.length],
    targetLowPct:  r.price_target_low_pct,
    targetHighPct: r.price_target_high_pct,
  }));
  // Owned first, then Managed; ID order within each group
  props.sort((a, b) => (b.owned - a.owned) || (a.id - b.id));
  return props;
}

const propIdList = () => PROPERTIES.map(p => p.id).join(',');
const plProps    = () => PROPERTIES.filter(p => p.plId);
const groupLabel = p => p.owned ? 'Owned' : 'Managed';

// Owned / Managed sub-header row for a property table: returns the header
// when `prop` starts a new group, otherwise ''.
function groupRow(prop, index, colspan) {
  if (index > 0 && PROPERTIES[index - 1]?.owned === prop.owned) return '';
  return `<tr><td colspan="${colspan}" style="padding:10px 12px 4px;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.04em;">${groupLabel(prop)}</td></tr>`;
}
// Same for per-property blocks (div layout)
function groupHeading(prop, index) {
  if (index > 0 && PROPERTIES[index - 1]?.owned === prop.owned) return '';
  return `<div style="margin:${index > 0 ? '18px' : '0'} 0 10px;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.04em;">${groupLabel(prop)}</div>`;
}

// ─── Run Log (daily_report_runs) ──────────────────────────────────────────────

// True if a report for this date was already sent from the same git ref.
// On main this covers the Supabase dispatch and the 9 AM backup schedule;
// a branch test run only ever matches its own branch's earlier runs.
async function alreadySentToday(todayStr) {
  const rows = await sb(
    `daily_report_runs?select=id&git_ref=eq.${encodeURIComponent(GIT_REF)}&report_date=eq.${todayStr}`
    + `&status=in.(sent,sent_with_failures)&limit=1`
  );
  return rows.length > 0;
}

async function startRunLog(todayStr, status) {
  const [row] = await sbWrite('POST', 'daily_report_runs', {
    report_date: todayStr, git_ref: GIT_REF, trigger_event: TRIGGER_EVENT,
    forced: FORCE_SEND, status, github_run_id: GITHUB_RUN_ID,
    ...(status === 'skipped' ? { finished_at: new Date().toISOString() } : {}),
  }, 'return=representation');
  return row.id;
}

async function finishRunLog(runId, status, resendId) {
  if (!runId) return;
  await sbWrite('PATCH', `daily_report_runs?id=eq.${runId}`, {
    status, finished_at: new Date().toISOString(),
    failures: [...failures, ...warnings.map(w => ({ ...w, warning: true }))],
    resend_id: resendId || null,
  });
}

// "Yesterday's report didn't run": no sent row on main for yesterday. A row
// still 'running' counts as not run. Checked on main runs only, and only once
// main has logged any earlier run (so the first day after cutover doesn't warn).
async function checkYesterdaySent(todayStr) {
  if (GIT_REF !== MAIN_REF) return;
  const yesterday = addDays(todayStr, -1);
  const [anyEarlier, sentYesterday] = await Promise.all([
    sb(`daily_report_runs?select=id&git_ref=eq.${encodeURIComponent(MAIN_REF)}&report_date=lt.${todayStr}&limit=1`),
    sb(`daily_report_runs?select=id&git_ref=eq.${encodeURIComponent(MAIN_REF)}&report_date=eq.${yesterday}&status=in.(sent,sent_with_failures)&limit=1`),
  ]);
  if (anyEarlier.length && !sentYesterday.length) {
    recordWarning('Yesterday\'s report', `No report was sent for ${fmtDateL(yesterday)}. Check the GitHub Actions run history and the Supabase daily-report-dispatch job.`);
  }
}

// ─── Data Fetching ────────────────────────────────────────────────────────────

async function fetchBookings90(fromDate, toDate) {
  return sb(
    `bookings?select=id,property_id,status,guest_display_name,arrival_date,departure_date,nights,gross_revenue,net_revenue,booking_channel,booked_at,charges_json`
    + `&property_id=in.(${propIdList()})&status=in.(active,blocked)&arrival_date=lt.${toDate}&departure_date=gt.${fromDate}`
    + `&order=arrival_date.asc`
  );
}

// A guest's own stay rent per night from charges_json: every line in the rent
// category (rent plus rent-category discounts such as Early Bird or Weekly),
// divided by nights. Includes the channel markup (it's in the rent line);
// excludes cleaning, fees and taxes. null when there's no rent.
function stayRentPerNight(booking) {
  if (!booking) return null;
  const charges = booking.charges_json || [];
  const rent = charges.filter(c => c.category === 'rent').reduce((s, c) => s + (Number(c.amount) || 0), 0);
  const nights = booking.nights || Math.max(1, diffDays(booking.arrival_date, booking.departure_date));
  return rent > 0 ? rent / nights : null;
}

async function fetchRecentActivity() {
  const since = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
  const ids = propIdList();
  const [newBookings, cancellations] = await Promise.all([
    sb(`bookings?select=id,property_id,guest_display_name,arrival_date,departure_date,nights,gross_revenue,booking_channel,booked_at&property_id=in.(${ids})&status=eq.active&booked_at=gte.${since}&order=booked_at.desc`),
    sb(`bookings?select=id,property_id,guest_display_name,arrival_date,departure_date,nights,gross_revenue,booking_channel,updated_at&property_id=in.(${ids})&status=eq.canceled&updated_at=gte.${since}&order=updated_at.desc`),
  ]);
  return { newBookings, cancellations };
}

async function fetchMTDRevenue(todayStr) {
  const thisStart = isoMonthStart(todayStr);
  const lyToday   = addDays(todayStr, -365);
  const lyStart   = isoMonthStart(lyToday);
  const ids       = propIdList();
  const [cur, ly] = await Promise.all([
    sb(`bookings?select=property_id,gross_revenue,net_revenue,nights&property_id=in.(${ids})&status=eq.active&arrival_date=gte.${thisStart}&arrival_date=lte.${todayStr}`),
    sb(`bookings?select=property_id,gross_revenue,net_revenue,nights&property_id=in.(${ids})&status=eq.active&arrival_date=gte.${lyStart}&arrival_date=lte.${lyToday}`),
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
  const ids          = propIdList();
  const [tyBookings, lyBookings] = await Promise.all([
    sb(`bookings?select=property_id,arrival_date,departure_date,nights,gross_revenue&property_id=in.(${ids})&status=eq.active&arrival_date=lt.${lastTYEnd}&departure_date=gt.${firstTYStart}&order=arrival_date.asc`),
    sb(`bookings?select=property_id,arrival_date,departure_date,nights,gross_revenue&property_id=in.(${ids})&status=eq.active&booked_at=lte.${lySnapshot}&arrival_date=lt.${lastLYEnd}&departure_date=gt.${firstLYStart}&order=arrival_date.asc`),
  ]);
  return { tyBookings, lyBookings };
}

async function fetchRevenueForecastData(paceMonths, todayStr) {
  const firstStart       = paceMonths[0].start;
  const lastEnd          = paceMonths[paceMonths.length - 1].end;
  const currentYearStart = `${todayStr.slice(0, 4)}-01-01`;

  const ids              = propIdList();

  // Fetch in parallel: current-year blocks for forecast months + all historical active/blocked
  // (history paged until complete — no row cap)
  const [tyBlocked, histActive, histBlocked] = await Promise.all([
    sbAll(`bookings?select=property_id,arrival_date,departure_date&property_id=in.(${ids})&status=eq.blocked&arrival_date=lt.${lastEnd}&departure_date=gt.${firstStart}&order=arrival_date.asc,id.asc`),
    sbAll(`bookings?select=property_id,arrival_date,departure_date,gross_revenue,booked_at&property_id=in.(${ids})&status=eq.active&arrival_date=lt.${currentYearStart}&order=arrival_date.asc,id.asc`),
    sbAll(`bookings?select=property_id,arrival_date,departure_date&property_id=in.(${ids})&status=eq.blocked&arrival_date=lt.${currentYearStart}&order=arrival_date.asc,id.asc`),
  ]);

  return { tyBlocked, histActive, histBlocked };
}

// ─── Tax Profiles ─────────────────────────────────────────────────────────────

// Each property's confirmed tax profile, same query as the portal
// (picture-perfect-stays-portal/api/get-bookings.js:96-97).
// Returns { [propertyId]: [{ name, rates: [{ rate, from }] }] } — active taxes only,
// rates sorted by effective_from.
async function fetchTaxProfiles() {
  const rows = await sb(
    `property_tax_profiles?status=eq.confirmed&property_id=in.(${propIdList()})`
    + `&select=property_id,tax_profiles(id,display_name,tax_profile_taxes(id,ownerrez_name,is_active,tax_rate_history(rate_percent,effective_from)))`
  );
  const byProp = {};
  for (const row of rows) {
    const taxes = row.tax_profiles?.tax_profile_taxes || [];
    byProp[row.property_id] = taxes.filter(t => t.is_active).map(t => ({
      name:  t.ownerrez_name,
      rates: (t.tax_rate_history || [])
        .map(r => ({ rate: Number(r.rate_percent), from: r.effective_from }))
        .sort((a, b) => (a.from || '').localeCompare(b.from || '')),
    }));
  }
  for (const p of PROPERTIES) {
    if (!byProp[p.id]) recordFailure('Tax profile', `${p.name} has no confirmed tax profile; gap night "Guest Pays" can't include tax.`);
  }
  return byProp;
}

// Total tax rate (decimal, e.g. 0.1397) in effect on `date` for a property:
// each active tax uses its latest rate with effective_from on or before the
// date, the same rule as the portal (get-bookings.js:113-116). The guest pays
// the full rate; exclusions only change who remits. null = no tax profile.
function taxRateOn(taxProfiles, propId, date) {
  const taxes = taxProfiles?.[propId];
  if (!taxes) return null;
  let total = 0;
  for (const t of taxes) {
    const current = t.rates.filter(r => !r.from || r.from <= date).pop();
    if (current) total += current.rate;
  }
  return total / 100;
}

// ─── Events Cache ─────────────────────────────────────────────────────────────

// The Event Discovery Scan (scan-events.yml) refreshes the cache Mon and Thu,
// so it should never be more than 4 days old; 6 allows one missed scan.
const EVENTS_CACHE_MAX_AGE_DAYS = 6;

function fetchEventsCache(todayStr) {
  try {
    const cachePath = join(__dirname, 'events-cache.json');
    if (!existsSync(cachePath)) {
      recordFailure('Events cache', 'events-cache.json is missing; only hard-coded events are shown.');
      return [];
    }
    const data = JSON.parse(readFileSync(cachePath, 'utf8'));
    const scanDate = data.scan_date || data.last_updated?.slice(0, 10);
    if (!scanDate || diffDays(scanDate, todayStr) > EVENTS_CACHE_MAX_AGE_DAYS) {
      recordWarning('Events cache', `Last event scan was ${scanDate ? fmtDate(scanDate) : 'never'}; Ticketmaster and ESPN events may be out of date. Check the Event Discovery Scan workflow.`);
    }
    return data.events || [];
  } catch (e) {
    recordFailure('Events cache', `events-cache.json could not be read (${e.message}); only hard-coded events are shown.`);
    return [];
  }
}

// Compute historical ADR for an event's date window from histActive bookings.
// Uses proration — counts only nights and revenue within the event dates.
// Returns { adr, nights, years } or null if insufficient data.
function computeEventADR(event, histActive, propId) {
  const currentYear = parseInt(today().slice(0, 4)); // Arizona year
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
  if (!PRICELABS_KEY) { recordFailure('PriceLabs prices', 'PRICELABS_API_KEY is not set.'); return null; }
  const listings = plProps().map(p => ({ id: p.plId, pms: 'ownerrez', dateFrom: fromDate, dateTo: toDate }));
  if (!listings.length) return null;
  const res = await fetch('https://api.pricelabs.co/v1/listing_prices', {
    method: 'POST',
    headers: { 'X-API-Key': PRICELABS_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ listings }),
  });
  if (!res.ok) {
    recordFailure('PriceLabs prices', `listing_prices returned HTTP ${res.status}: ${(await res.text()).slice(0, 150)}`);
    return null;
  }
  const raw = await res.json();
  // Transform: array of { id, data: [...] } → { plId: { date: priceObj } }
  const plData = {};
  for (const listing of (Array.isArray(raw) ? raw : (raw.listings || []))) {
    if (listing.error) {
      const prop = PROPERTIES.find(p => p.plId === String(listing.id));
      recordFailure('PriceLabs prices', `${prop?.name ?? listing.id}: ${listing.error_status || listing.error}`);
      continue;
    }
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
  for (const p of plProps()) {
    if (plData[p.plId] && !Object.keys(plData[p.plId]).length) {
      recordFailure('PriceLabs prices', `${p.name}: PriceLabs returned no dates.`);
    }
  }
  // No listing returned usable prices: treat as not loaded, not as an empty success
  if (!Object.values(plData).some(d => Object.keys(d).length)) return null;
  return plData;
}

// Fallback: load PriceLabs data from a pre-generated JSON file. Local runs only;
// in GitHub Actions a file must never stand in for live prices.
function loadPriceLabsFile() {
  if (!PL_DATA_FILE) return null;
  if (IS_CI) {
    recordFailure('PriceLabs prices', 'PRICELABS_DATA_FILE is set in GitHub Actions; ignored (file prices are for local runs only).');
    return null;
  }
  try { return JSON.parse(readFileSync(PL_DATA_FILE, 'utf8')); }
  catch (e) { console.warn('Could not read PRICELABS_DATA_FILE:', e.message); return null; }
}

// Snapshot today's PriceLabs prices to Supabase for historical analysis.
// Upserts on (property_id, date) — safe to run daily, overwrites with latest data.
async function snapshotPriceLabsData(plData, capturedAt) {
  const rows = [];
  for (const prop of plProps()) {
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
  const chunks = Math.ceil(rows.length / CHUNK);
  let upserted = 0, failedChunks = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/pricing_snapshots?on_conflict=property_id,date`, {
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
      failedChunks++;
      console.warn(`  pricing_snapshots chunk ${Math.floor(i/CHUNK)+1} failed: ${err.slice(0, 120)}`);
    } else {
      upserted += rows.slice(i, i + CHUNK).length;
    }
  }
  if (failedChunks) {
    recordFailure('Price snapshot', `FAILED: ${failedChunks} of ${chunks} chunks; ${upserted} of ${rows.length} rows saved to pricing_snapshots.`);
  }
  return upserted;
}

// ─── PriceLabs Pricing Alerts ─────────────────────────────────────────────────

async function plGet(path) {
  const res = await fetch(`https://api.pricelabs.co/v1${path}`, {
    headers: { 'X-API-Key': PRICELABS_KEY },
  });
  if (!res.ok) throw new Error(`PriceLabs GET ${path.split('?')[0]} returned HTTP ${res.status}`);
  return res.json();
}

// Fetch listing settings (occupancy vs market) + neighborhood market percentiles for all properties.
// Every missing piece is recorded as a failure; result[plId].settings / .market are null when missing.
async function fetchPricingAlertData() {
  if (!PRICELABS_KEY) return null;
  // /listings returns every listing with occupancy_next_30/60 and market_occupancy_next_30/60
  let allSettings = [];
  try {
    allSettings = (await plGet('/listings'))?.listings || [];
  } catch (e) {
    recordFailure('PriceLabs settings', `${e.message}; pricing alerts can't be checked.`);
  }

  // Neighborhood data (market percentiles) per property — these are large, fetch in parallel
  const marketResults = await Promise.all(
    plProps().map(p =>
      plGet(`/neighborhood_data?pms=ownerrez&listing_id=${p.plId}`)
        .then(d => ({ plId: p.plId, data: d }))
        .catch(e => { recordFailure('PriceLabs market data', `${p.name}: ${e.message}`); return { plId: p.plId, data: null }; })
    )
  );

  const result = {};
  for (const p of plProps()) {
    const settings = allSettings.find(s => String(s.id) === p.plId) || null;
    const market   = marketResults.find(r => r.plId === p.plId)?.data || null;
    if (allSettings.length && !settings) recordFailure('PriceLabs settings', `${p.name}: listing ${p.plId} not found in PriceLabs /listings.`);
    if (market && !market.data) recordFailure('PriceLabs market data', `${p.name}: neighborhood data came back empty.`);
    result[p.plId] = { settings, market };
  }
  return result;
}

// Parse "25 %" → 0.25, null/undefined → null
function parseOcc(str) {
  if (str == null) return null;
  const n = parseFloat(str);
  return isNaN(n) ? null : n / 100;
}

// Convert cumulative occupancy (occ_next_30, occ_next_60) to per-window rates
// window 30 = days 1-30, window 60 = days 31-60. null when PriceLabs didn't
// send the figure (never treated as 0% occupancy).
function windowOcc(occ30str, occ60str, windowEnd) {
  const o30 = parseOcc(occ30str);
  const o60 = parseOcc(occ60str);
  if (windowEnd === 30) return o30;
  if (windowEnd === 60) return o30 == null || o60 == null ? null : Math.max(0, (o60 * 60 - o30 * 30) / 30);
  return null; // 61-90 not available
}

// Pick the market category for this bedroom count. Falling back to another
// bedroom count is recorded, since it compares against the wrong market.
function marketCategory(series, seriesName, bedroomCount, propName) {
  const catKey = String(bedroomCount);
  if (series.Category[catKey]) return series.Category[catKey];
  const fallbackKey = series.Category['1'] ? '1' : Object.keys(series.Category)[0];
  if (fallbackKey == null) return null;
  recordFailure('PriceLabs market data', `${propName}: no ${bedroomCount}-bedroom market in "${seriesName}"; compared against ${fallbackKey}-bedroom instead.`);
  return series.Category[fallbackKey];
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

// Market percentiles available from PriceLabs "Future Percentile Prices"
const PERCENTILES = [25, 50, 75, 90];
const percentileSeriesLogged = new Set();

// Which Y_values series holds which percentile, matched by the series labels
// only. Never by position: PriceLabs' real order is 25th, 50th, 75th,
// Median Booked Price, 90th. Returns null when the labels are missing or
// don't name all four percentiles.
function percentileSeriesIndex(series, category, propName) {
  const nSeries = (category.Y_values || []).length;
  // The label list is the array of strings, one per Y_values series, on the
  // category or the series object (key name not relied on)
  const isLabelList = v => Array.isArray(v) && v.length === nSeries && v.every(x => typeof x === 'string');
  const labels = [category, series].flatMap(o => Object.values(o || {})).find(isLabelList) || null;
  const byPct = {};
  (labels || []).forEach((label, i) => {
    const m = String(label).match(/\b(25|50|75|90)(?:st|nd|rd|th)?\b/);
    if (m && !/median booked/i.test(label)) byPct[m[1]] = i;
  });
  const complete = PERCENTILES.every(p => byPct[p] != null);
  if (!percentileSeriesLogged.has(propName)) {
    percentileSeriesLogged.add(propName);
    console.log(`  Market percentiles for ${propName}: labels ${JSON.stringify(labels)} → ${complete ? JSON.stringify(byPct) : 'incomplete'}`);
  }
  if (!complete) {
    recordFailure('PriceLabs market data', `${propName}: percentile series labels missing or incomplete (${labels ? labels.join(', ') : 'no labels'}); pricing not checked.`);
    return null;
  }
  return byPct;
}

// Build date → { p25, p50, p75, p90 } lookup from neighborhood_data for a given bedroom count.
// null = percentiles couldn't be read (the property is then "not checked").
function parseMarketPercentiles(marketData, bedroomCount, propName) {
  if (!marketData?.data) return null;
  const fpp = marketData.data['Future Percentile Prices'];
  if (!fpp?.Category) {
    recordFailure('PriceLabs market data', `${propName}: no "Future Percentile Prices" in neighborhood data.`);
    return null;
  }

  // Category keys are bedroom counts as strings
  const category = marketCategory(fpp, 'Future Percentile Prices', bedroomCount, propName);
  if (!category) return null;

  const dates = category.X_values || [];
  const yVals = category.Y_values || [];
  const idx   = percentileSeriesIndex(fpp, category, propName);
  if (!idx) return null;

  const map = {};
  dates.forEach((d, i) => {
    const point = {};
    for (const p of PERCENTILES) point[`p${p}`] = (yVals[idx[p]] || [])[i] ?? null;
    map[d] = point;
  });
  return map;
}

// Compute alerts for a single property across three windows.
// Alerts only: nothing here recommends or applies a base price.
// Price position is judged against the property's own target range
// (properties.price_target_low_pct / price_target_high_pct; default 50th–75th).
// Returns null when PriceLabs settings or market data are missing, so the
// caller can say the property couldn't be checked (never "within normal range").
function computePropertyAlerts(prop, plData, alertData, bookings, todayStr) {
  const propAlertData = alertData?.[prop.plId];
  if (!propAlertData?.settings || !propAlertData?.market) return null;

  const { settings, market } = propAlertData;
  if (settings.occupancy_next_30 == null || settings.market_occupancy_next_30 == null) {
    recordFailure('PriceLabs settings', `${prop.name}: occupancy figures missing; alerts use price thresholds only.`);
  }
  const bedroomCount  = settings.no_of_bedrooms ?? 1;
  const percentiles   = parseMarketPercentiles(market, bedroomCount, prop.name);
  if (!percentiles) return null;
  const prices        = plData?.[prop.plId] ?? {};
  const occ           = occupiedSet(bookings, prop.id); // open nights only — booked nights can't be repriced
  const lowKey        = `p${prop.targetLowPct}`;
  const highKey       = `p${prop.targetHighPct}`;
  const targetLabel   = `${ordinal(prop.targetLowPct)}–${ordinal(prop.targetHighPct)}`;

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

    // Market percentile averages for this window, at the property's target range
    const mktPoints = windowDates.map(d => percentiles[d]).filter(m => m && m[lowKey] != null && m[highKey] != null);
    if (mktPoints.length === 0) {
      recordFailure('PriceLabs market data', `${prop.name}: no ${targetLabel} percentile prices for ${win.label.split(' (')[0].toLowerCase()}.`);
      continue;
    }
    const avgLow  = mktPoints.reduce((s, m) => s + m[lowKey], 0) / mktPoints.length;
    const avgHigh = mktPoints.reduce((s, m) => s + m[highKey], 0) / mktPoints.length;
    if (!avgLow || !avgHigh) continue;

    const highOn = d => percentiles[d]?.[highKey] ?? avgHigh;
    const nightsAboveHigh = datesWithPrice.filter(d => prices[d].price > highOn(d)).length;
    const pctAboveHigh    = nightsAboveHigh / datesWithPrice.length;
    const position = avgPrice > avgHigh ? 'above' : avgPrice < avgLow ? 'below' : 'in';

    const propOcc = win.propOcc;
    const mktOcc  = win.mktOcc;
    const hasOccData = propOcc != null && mktOcc != null;

    const occupancyBeatMarket = hasOccData && propOcc >= mktOcc;
    const occupancyGap        = hasOccData ? mktOcc - propOcc : 0;
    const occupancyHalfMkt    = hasOccData && mktOcc > 0 && propOcc < mktOcc * 0.5;

    // Thresholds measured against the target range instead of the fixed
    // 50th/75th: RED = >30% of open nights above the range with occupancy
    // >10 pts behind market, or occupancy under half the market; YELLOW =
    // >20% of nights above the range, or the average price above the range,
    // or the average price below the range while occupancy is >10 pts ahead
    // of market (room to raise). An occupancy gap is only called "not a
    // price issue" when price isn't above the range; otherwise it's flagged
    // as overpriced.
    let level = null, reason = null;
    if (occupancyBeatMarket) {
      if (position === 'below' && propOcc - mktOcc > 0.10) { level = 'YELLOW'; reason = 'below_target'; }
    } else {
      if (hasOccData) {
        if (pctAboveHigh > 0.30 && occupancyGap > 0.10) { level = 'RED'; reason = 'overpriced'; }
        else if (occupancyHalfMkt) { level = 'RED'; reason = position === 'above' ? 'overpriced' : 'occupancy_gap'; }
      }
      if (!level && pctAboveHigh > 0.20) { level = 'YELLOW'; reason = 'overpriced'; }
      if (!level && position === 'above') { level = 'YELLOW'; reason = 'above_market'; }
    }

    const pctVsHigh = Math.round((avgPrice / avgHigh - 1) * 100);
    let action;
    if (!level) {
      action = '✓ Within normal range';
    } else if (reason === 'below_target') {
      action = `Priced below target while booking ahead of market (${ordinal(prop.targetLowPct)}–${ordinal(prop.targetHighPct)} target range).`;
    } else if (reason === 'occupancy_gap') {
      action = `Price is ${position === 'below' ? 'below' : 'in'} your ${targetLabel} target range — demand is the issue, not price. No price change suggested; check listing rank, photos, and reviews on Airbnb/VRBO.`;
    } else if (reason === 'overpriced') {
      action = `${nightsAboveHigh} of ${datesWithPrice.length} open nights are above your target range (${ordinal(prop.targetHighPct)} percentile)${level === 'RED' ? ' and occupancy is lagging the market' : ''}. Review these dates in PriceLabs.`;
    } else {
      action = `Average price ${fmt$(avgPrice)} is ${pctVsHigh}% above your ${targetLabel} target range. Review this window in PriceLabs.`;
    }

    alerts.push({
      window: win.label, level: level || 'OK', reason,
      avgPrice: Math.round(avgPrice),
      targetLow: Math.round(avgLow), targetHigh: Math.round(avgHigh), targetLabel, position,
      nightsAboveHigh, totalNights: datesWithPrice.length,
      propOcc: propOcc != null ? Math.round(propOcc * 100) : null,
      mktOcc:  mktOcc  != null ? Math.round(mktOcc  * 100) : null,
      action,
    });
  }

  return alerts;
}

const ordinal = n => `${n}th`; // only 25, 50, 75, 90 are allowed

function sectionPricingAlerts(plData, alertData, bookings, todayStr) {
  let html = `<h2 id="section-pricing" style="${H2}">🚨 Pricing Alerts</h2>`;

  if (!PRICELABS_KEY || !alertData || !plData) {
    return html + `<p style="color:#c0392b;font-size:13px;">Pricing alerts couldn't be checked — PriceLabs data is missing. See the alert at the top of this email.</p>`;
  }

  const RED_BG = '#fff0f0', RED_COLOR = '#c0392b', RED_BADGE = '#fde8e8';
  const YLW_BG = '#fffbf0', YLW_COLOR = '#d97706', YLW_BADGE = '#fef3c7';
  const GRN_COLOR = '#1a7f5a';

  // Collect rows for ALL properties × ALL windows (not just alerting ones)
  const allRows = [];
  const unchecked = [];
  PROPERTIES.forEach((prop, i) => {
    const first = allRows.length;
    if (!prop.plId) {
      allRows.push({ prop, note: 'No PriceLabs listing linked' });
    } else {
      const alerts = computePropertyAlerts(prop, plData, alertData, bookings, todayStr);
      if (alerts === null) {
        unchecked.push(prop.name);
        allRows.push({ prop, note: "Couldn't check — PriceLabs settings or market data missing (see the alert at the top)", isError: true });
      } else {
        alerts.forEach(a => allRows.push({ prop, ...a }));
      }
    }
    if (allRows.length > first) allRows[first].groupRow = groupRow(prop, i, 8);
  });

  const redAlerts = allRows.filter(a => a.level === 'RED');
  const ylwAlerts = allRows.filter(a => a.level === 'YELLOW');

  if (unchecked.length) {
    html += `<div style="padding:6px 12px;background:${RED_BADGE};border-radius:6px;margin-bottom:10px;font-size:12px;color:${RED_COLOR};font-weight:700;">
      ⚠ ${unchecked.join(' & ')} couldn't be checked today
    </div>`;
  }
  if (redAlerts.length) {
    html += `<div style="padding:6px 12px;background:${RED_BADGE};border-radius:6px;margin-bottom:10px;font-size:12px;color:${RED_COLOR};font-weight:700;">
      🔴 ${redAlerts.length} RED alert${redAlerts.length > 1 ? 's' : ''} — immediate attention needed
    </div>`;
  } else if (ylwAlerts.length === 0 && unchecked.length === 0) {
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
      <th style="${TH}text-align:right;">Target Range</th>
      <th style="${TH}text-align:right;">Open Nts Above</th>
      <th style="${TH}text-align:right;">Occ / Mkt</th>
      <th style="${TH}">Note</th>
    </tr>`;

  const POSITION = { above: ['Above', RED_COLOR], in: ['In range', GRN_COLOR], below: ['Below', '#2980b9'] };

  for (const a of allRows) {
    html += a.groupRow || '';
    if (a.note) {
      html += `<tr style="border-bottom:1px solid #f0f0f0;">
        <td style="padding:7px 10px;">${badge(a.prop.name, a.prop.color)}</td>
        <td colspan="7" style="padding:7px 10px;${a.isError ? `color:${RED_COLOR};` : 'color:#888;font-style:italic;'}">${a.note}</td>
      </tr>`;
      continue;
    }
    const isRed = a.level === 'RED';
    const isYlw = a.level === 'YELLOW';
    const isOK  = a.level === 'OK';
    const rowBg     = isRed ? RED_BG : isYlw ? YLW_BG : '#fff';
    const levelColor = isRed ? RED_COLOR : isYlw ? YLW_COLOR : GRN_COLOR;
    const levelLabel = isOK ? '✓ OK' : a.level;
    const occStr = a.propOcc != null && a.mktOcc != null ? `${a.propOcc}% / ${a.mktOcc}%` : '—';
    const [posLabel, posColor] = POSITION[a.position];
    html += `<tr style="background:${rowBg};border-bottom:1px solid #f0f0f0;">
      <td style="padding:7px 10px;">${badge(a.prop.name, a.prop.color)}</td>
      <td style="padding:7px 10px;color:#555;">${a.window}</td>
      <td style="padding:7px 10px;text-align:center;">
        <span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700;background:${levelColor}22;color:${levelColor};">${levelLabel}</span>
      </td>
      <td style="padding:7px 10px;text-align:right;font-weight:600;">${fmt$(a.avgPrice)}
        <div style="font-size:10px;font-weight:600;color:${posColor};">${posLabel}</div></td>
      <td style="padding:7px 10px;text-align:right;color:#666;">${fmt$(a.targetLow)}–${fmt$(a.targetHigh)}
        <div style="font-size:10px;color:#aaa;">${a.targetLabel} pct</div></td>
      <td style="padding:7px 10px;text-align:right;color:#666;">${a.nightsAboveHigh} / ${a.totalNights}</td>
      <td style="padding:7px 10px;text-align:right;color:#666;">${occStr}</td>
      <td style="padding:7px 10px;color:${isOK ? '#888' : '#444'};font-size:11px;">${a.action}</td>
    </tr>`;
  }
  html += `</table>
  <p style="font-size:11px;color:#aaa;margin:8px 0 0;">Alerts only — nothing here changes prices. Target range = the market percentiles each property aims for (set per property; default 50th–75th). Open nights only.</p>`;
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

// 1-night gaps between two stays (minimum stay is 2 and PriceLabs shrinks the
// minimum to fit longer gaps, so only 1-night gaps are true orphans).
// Owner blocks count as stays for finding the gap. Each side is a possible
// offer: the checkout guest (stay one more night) and the checkin guest
// (arrive a night early). Owner blocks and insurance stays aren't offered.
// Returns [{ date, sides: [{ role, booking, guest, channel, rentPerNight, offer }] }]
function gapNights(bookings, propId, from, to) {
  const sorted = bookings
    .filter(b => b.property_id === propId)
    .sort((a, b) => a.arrival_date.localeCompare(b.arrival_date));
  const gaps = [];
  let prev = null; // stay with the latest departure so far
  for (const next of sorted) {
    if (prev && diffDays(prev.departure_date, next.arrival_date) === 1) {
      const date = prev.departure_date;
      if (date >= from && date < to) {
        const sides = [
          { role: 'checkout', booking: prev },
          { role: 'checkin',  booking: next },
        ]
          .filter(s => !isOwnerBlock(s.booking) && !isInsuranceStay(s.booking))
          .map(s => {
            const rentPerNight = stayRentPerNight(s.booking);
            return {
              ...s,
              guest:   (s.booking.guest_display_name || 'Guest').trim(),
              channel: channelLabel(s.booking),
              rentPerNight,
              offer:   rentPerNight != null ? rentPerNight * GAP_OFFER_FACTOR : null,
            };
          });
        if (sides.length) gaps.push({ date, checkOut: prev.departure_date, checkIn: next.arrival_date, sides });
      }
    }
    if (!prev || next.departure_date > prev.departure_date) prev = next;
  }
  return gaps;
}

// Offer table for one gap night: one row per guest who can be offered it.
// taxRate = total tax rate in effect on the gap night (decimal); null when the
// property has no confirmed tax profile. plPrice = PriceLabs' current price
// for the night, shown for reference only.
function gapOfferTable(gap, taxRate, plPrice) {
  const cell = 'padding:5px 8px;text-align:right;';
  const rows = gap.sides.map(s => {
    if (s.offer == null) {
      return `<tr style="border-bottom:1px solid #f0f0f0;">
        <td style="padding:5px 8px;">${s.guest} <span style="color:#888;">(${s.channel}, ${s.role === 'checkout' ? 'stay a night longer' : 'arrive a night early'})</span></td>
        <td colspan="4" style="padding:5px 8px;color:#aaa;font-style:italic;">No rent on this booking — can't price an offer</td>
      </tr>`;
    }
    const tax   = taxRate == null ? null : s.offer * taxRate;
    const net   = gapNetByChannel(s.offer, tax ?? 0, s.booking.booking_channel);
    const netCell = net == null
      ? `<span style="color:#aaa;font-style:italic;">not offered</span>`
      : taxRate == null && channelKind(s.booking.booking_channel) !== 'airbnb'
        ? `${fmt$(net)}<div style="font-size:10px;color:#aaa;">excl. Stripe on tax</div>`
        : fmt$(net);
    return `<tr style="border-bottom:1px solid #f0f0f0;">
      <td style="padding:5px 8px;">${s.guest} <span style="color:#888;">(${s.channel}, ${s.role === 'checkout' ? 'stay a night longer' : 'arrive a night early'})</span></td>
      <td style="${cell}color:#666;">${fmt$(s.rentPerNight)}</td>
      <td style="${cell}font-weight:700;color:#1a7f5a;">${fmt$(s.offer)}</td>
      <td style="${cell}">${tax == null ? '—' : fmt$(s.offer + tax)}</td>
      <td style="${cell}">${netCell}</td>
    </tr>`;
  }).join('');
  return `<table style="width:100%;border-collapse:collapse;font-size:12px;margin-top:6px;">
    <tr style="background:#f8f9fa;">
      <th style="padding:5px 8px;text-align:left;color:#555;font-weight:600;">Offer to</th>
      <th style="padding:5px 8px;text-align:right;color:#555;font-weight:600;">Their Rate/Nt</th>
      <th style="padding:5px 8px;text-align:right;color:#555;font-weight:600;">Offer<br><span style="font-weight:400;font-size:10px;">25% off</span></th>
      <th style="padding:5px 8px;text-align:right;color:#555;font-weight:600;">Guest Pays<br><span style="font-weight:400;font-size:10px;">${taxRate == null ? 'tax profile missing' : `incl. ${(taxRate * 100).toFixed(2)}% tax`}</span></th>
      <th style="padding:5px 8px;text-align:right;color:#555;font-weight:600;">Your Net</th>
    </tr>${rows}
  </table>
  <div style="font-size:11px;color:#888;margin-top:4px;">PriceLabs price for this night: ${plPrice > 0 ? fmt$(plPrice) : '—'} (reference only)</div>`;
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

// Returns a note {text, color, bg} describing an open night as check-in nears
// (days out, demand, current price), or null. Describes only; never suggests a price.
function pricingUrgencyNote(daysOut, demandDesc, currentPrice) {
  const isLow  = demandDesc === 'Low Demand';
  const isNorm = demandDesc === 'Normal Demand';
  const days   = daysOut === 0 ? 'Tonight' : `${daysOut} day${daysOut !== 1 ? 's' : ''} out`;
  const price  = fmt$(currentPrice);

  if (daysOut <= 3) {
    return { text: `🔴 ${days}, still open at ${price}`, color: '#c0392b', bg: '#fef5f5' };
  }
  if (daysOut <= 7 && isLow) {
    return { text: `🔴 ${days}, low demand, open at ${price}`, color: '#c0392b', bg: '#fef5f5' };
  }
  if (daysOut <= 7 && isNorm) {
    return { text: `🟡 ${days}, open at ${price}`, color: '#e67e22', bg: '#fffbf3' };
  }
  if (daysOut <= 14 && isLow) {
    return { text: `🟡 ${days}, low demand, open at ${price}`, color: '#e67e22', bg: '#fffbf3' };
  }
  if (daysOut <= 30 && isLow) {
    return { text: `👀 ${days}, low demand`, color: '#888', bg: '' };
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
  PROPERTIES.forEach((p, i) => {
    const c = cur[p.id], l = ly[p.id];
    totalCur += c.gross; totalLY += l.gross;
    const yoy = l.gross ? ((c.gross - l.gross) / l.gross) * 100 : null;
    const yoyStr = yoy != null ? `${yoy >= 0 ? '+' : ''}${Math.round(yoy)}%` : '—';
    const yoyColor = yoy == null ? '#999' : yoy >= 0 ? '#1a7f5a' : '#c0392b';
    rows += groupRow(p, i, 5) + `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;">${tag(p)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;text-align:right;font-weight:600;">${fmt$(c.gross)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;text-align:right;color:#666;">${fmt$(l.gross)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;text-align:right;font-weight:600;color:${yoyColor};">${yoyStr}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;text-align:right;color:#888;font-size:12px;">${c.count} bkg · ${c.nights} nts</td>
    </tr>`;
  });
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
    p.market !== MARKETS.SCOTTSDALE
  );
  if (noLyProps.length > 0)
    contextNotes.push(`${noLyProps.map(p => p.name).join(' & ')} show${noLyProps.length === 1 ? 's' : ''} $0 LY — no prior-year data at this snapshot point`);

  // Note 2: Any pace month in May–Sep for a Scottsdale property = last-minute booking market
  const scPropIds = new Set(PROPERTIES.filter(p => p.market === MARKETS.SCOTTSDALE).map(p => p.id));
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
    PROPERTIES.forEach((p, i) => {
      const tyRev = ty[p.id].revenue, lyRev = ly[p.id].revenue;
      const tyNts = ty[p.id].nights,  lyNts = ly[p.id].nights;
      totTYRev += tyRev; totLYRev += lyRev; totTYNts += tyNts; totLYNts += lyNts;
      const yoy      = lyRev > 0 ? (tyRev - lyRev) / lyRev * 100 : null;
      const yoyStr   = yoy != null ? `${yoy >= 0 ? '+' : ''}${Math.round(yoy)}%` : '—';
      const yoyColor = yoy == null ? '#999' : yoy >= 5 ? '#1a7f5a' : yoy < -5 ? '#c0392b' : '#e67e22';
      rows += groupRow(p, i, 5) + `<tr>
        <td style="padding:7px 12px;border-bottom:1px solid #f0f0f0;">${tag(p)}</td>
        <td style="padding:7px 12px;border-bottom:1px solid #f0f0f0;text-align:right;font-weight:600;">${fmt$(Math.round(tyRev))}</td>
        <td style="padding:7px 12px;border-bottom:1px solid #f0f0f0;text-align:right;color:#666;">${fmt$(Math.round(lyRev))}</td>
        <td style="padding:7px 12px;border-bottom:1px solid #f0f0f0;text-align:right;font-weight:600;color:${yoyColor};">${yoyStr}</td>
        <td style="padding:7px 12px;border-bottom:1px solid #f0f0f0;text-align:right;color:#888;font-size:12px;">${Math.round(tyNts)}n / ${Math.round(lyNts)}n</td>
      </tr>`;
    });
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
    forecasts.forEach((f, i) => {
      rows += groupRow(f.prop, i, 8);
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
          : !f.prop.plId ? 'No PriceLabs listing linked'
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
    });

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
    const affectedProps = PROPERTIES.filter(p => p.market === ev.market);

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
      const affectedProps = PROPERTIES.filter(p => p.market === ev.market);
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
        <span style="color:#888;"> · ${p?.name ?? '?'} · ${fmtDate(b.arrival_date)}–${fmtDate(b.departure_date)} (${n}n) · ${channelLabel(b)} · </span>
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
        <span style="color:#888;"> · ${p?.name ?? '?'} · ${fmtDate(b.arrival_date)}–${fmtDate(b.departure_date)} (${n}n) · ${channelLabel(b)} · </span>
        <strong style="color:#c0392b;">${fmt$(b.gross_revenue)}</strong>
      </div>`;
    }
  }
  return html;
}

function sectionOpenNights(bookings, todayStr, taxProfiles, plData) {
  const t30 = addDays(todayStr, 30), t60 = addDays(todayStr, 60), t90 = addDays(todayStr, 90);
  let html = `<h2 id="section-gaps" style="${H2}">📅 Open Nights & Gap Opportunities</h2>`;

  PROPERTIES.forEach((p, i) => {
    html += groupHeading(p, i);
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
      html += `<div style="margin-top:8px;padding:10px 14px;background:#fff8e1;border-radius:6px;border-left:3px solid #f39c12;">
        <div style="font-size:12px;font-weight:700;color:#e67e22;margin-bottom:8px;">⚡ 1-Night Gaps — outreach opportunities (${gaps.length})</div>`;
      gaps.forEach((g, gi) => {
        const isLast = gi === gaps.length - 1;
        const plPrice = plData?.[p.plId]?.[g.date]?.price;
        html += `<div style="margin-bottom:${isLast ? '0' : '16px'};padding-bottom:${isLast ? '0' : '16px'};border-bottom:${isLast ? 'none' : '1px solid #f0e0a0'};">
          <div style="font-size:13px;margin-bottom:3px;"><strong>${fmtDateL(g.date)}</strong>
            <span style="font-size:12px;color:#888;">· between checkout ${fmtDate(g.checkOut)} and checkin ${fmtDate(g.checkIn)}</span></div>
          ${gapOfferTable(g, taxRateOn(taxProfiles, p.id, g.date), plPrice)}
        </div>`;
      });
      html += `</div>`;
    }
    html += `</div>`;
  });
  return html;
}

function sectionPrices(bookings, plData, todayStr, alertData) {
  const t90 = addDays(todayStr, 90);
  let html = `<h2 id="section-prices" style="${H2}">💰 Pricing — Open Days (Next 90)</h2>`;

  if (!plData) {
    html += `<p style="color:#c0392b;font-size:13px;">
      PriceLabs prices unavailable — see the alert at the top of this email for the cause.
    </p>`;
    return html;
  }

  PROPERTIES.forEach((p, i) => {
    html += groupHeading(p, i);
    if (!p.plId) {
      html += `<div style="margin-bottom:16px;">${tag(p)} <span style="color:#888;font-size:13px;font-style:italic;margin-left:8px;">No PriceLabs listing linked</span></div>`;
      return;
    }
    const open = openDates(bookings, p.id, todayStr, t90);
    const propPrices = plData[p.plId] || {};
    // Min price from live PriceLabs settings
    const liveMinPrice = alertData?.[p.plId]?.settings?.min ?? null;

    if (!open.length) {
      html += `<div style="margin-bottom:16px;">${tag(p)} <span style="color:#1a7f5a;font-size:13px;margin-left:8px;">Fully booked for the next 90 days 🎉</span></div>`;
      return;
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
        const urgencyNote = pricingUrgencyNote(daysOut, r.demand_desc, r.price);
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
  });
  return html;
}

// ─── Email Shell ──────────────────────────────────────────────────────────────

const H2 = `font-size:15px;font-weight:700;color:#1a1a2e;margin:0 0 14px;padding-bottom:10px;border-bottom:2px solid #f0f0f0;`;
const TH = `padding:7px 12px;text-align:left;font-weight:600;color:#555;`;
const TD = `padding:6px 12px;border-bottom:1px solid #f0f0f0;`;
const SECTION = `background:#fff;border-radius:8px;padding:20px 24px;margin-bottom:16px;border:1px solid #e8e8e8;`;

// Note: SVG icons are stripped by Gmail — using emoji instead for universal rendering

// Red banner listing every failed or partial step (and any warnings) at the top
// of the email. Empty string when the run was clean.
function sectionStatusBanner() {
  if (!failures.length && !warnings.length) return '';
  const item = (x, color) =>
    `<li style="margin:3px 0;color:${color};"><strong>${x.step}:</strong> ${x.detail}</li>`;
  const failHtml = failures.length
    ? `<div style="font-size:14px;font-weight:700;color:#c0392b;margin:0 0 6px;">⚠ ${failures.length} problem${failures.length > 1 ? 's' : ''} in today's report — numbers that depend on ${failures.length > 1 ? 'these' : 'this'} may be missing or incomplete</div>
       <ul style="margin:0 0 ${warnings.length ? '10px' : '0'};padding-left:18px;font-size:12px;">${failures.map(f => item(f, '#7f1d1d')).join('')}</ul>`
    : '';
  const warnHtml = warnings.length
    ? `<div style="font-size:13px;font-weight:700;color:#b45309;margin:0 0 4px;">Heads up</div>
       <ul style="margin:0;padding-left:18px;font-size:12px;">${warnings.map(w => item(w, '#78350f')).join('')}</ul>`
    : '';
  const border = failures.length ? '#e74c3c' : '#d97706';
  const bg     = failures.length ? '#fff0f0' : '#fffbf0';
  return `<div style="background:${bg};border-radius:10px;padding:14px 20px;margin-bottom:16px;border:1px solid ${border}55;border-left:4px solid ${border};">${failHtml}${warnHtml}</div>`;
}

// Short section placeholder when the data a section needs failed to load
function sectionUnavailable(id, title) {
  return `<h2 id="${id}" style="${H2}">${title}</h2>
  <p style="color:#c0392b;font-size:13px;">Data for this section couldn't be loaded — see the alert at the top of this email.</p>`;
}

function buildEmail(todayStr, sections, priorityBoardHtml = '', bannerHtml = '') {
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

  ${bannerHtml}
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
        .catch(e => {
          recordFailure('Last booking date', `${p.name}: ${e.message}; the "no new bookings" check was skipped.`);
          return { propId: p.id, booked_at: null };
        })
    )
  );
  const map = {};
  for (const r of results) map[r.propId] = r.booked_at;
  return map;
}

// Generate the "because" explanation for a pricing alert — used in the Action Board
// Alerts only: describes where price and occupancy stand; never recommends a base price.
function alertBecause(a) {
  const occStr = a.propOcc != null && a.mktOcc != null ? ` Your occupancy ${a.propOcc}% vs market ${a.mktOcc}%.` : '';
  const range  = `${a.targetLabel} target range (${fmt$(a.targetLow)}–${fmt$(a.targetHigh)})`;
  if (a.reason === 'below_target') {
    return `Priced below target while booking ahead of market.${occStr}`;
  }
  if (a.reason === 'occupancy_gap') {
    return `Price is ${a.position === 'below' ? 'below' : 'in'} your ${range}, but occupancy (${a.propOcc}%) is less than half the market rate (${a.mktOcc}%). Demand is the issue, not price — check listing visibility, photos, and reviews.`;
  }
  if (a.reason === 'overpriced') {
    const pct = Math.round(a.nightsAboveHigh / a.totalNights * 100);
    return `${a.nightsAboveHigh} of ${a.totalNights} open nights (${pct}%) are priced above your ${range}${a.level === 'RED' ? ' and occupancy is lagging' : ''}.${occStr} Review these dates in PriceLabs.`;
  }
  return `Average price ${fmt$(a.avgPrice)} is above your ${range}.${occStr}`;
}

function buildPropertySummaries(plData, alertData, bookings, lastBookedMap, activity, mtd, tyBookings, lyBookings, paceMonths, hardcodedEvents, cachedEvents, todayStr) {
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
    // A property PriceLabs couldn't check is flagged, never shown as on track
    const propAlerts = prop.plId && plData && alertData
      ? computePropertyAlerts(prop, plData, alertData, bookings, todayStr)
      : null;
    if (prop.plId && propAlerts === null) {
      actions.push({
        level: 'yellow', anchor: '#section-pricing', sectionLabel: 'Pricing Alerts',
        text: 'Pricing couldn\'t be checked today — PriceLabs data is missing (see the alert at the top).',
      });
    }
    if (propAlerts) {
      for (const a of propAlerts) {
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
      if (prop.market !== evt.market) continue;
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

    // 5. 1-night gaps in next 14 days — soonest one + count
    const nearGaps = gapNights(bookings, prop.id, todayStr, t14);
    if (nearGaps.length > 0) {
      const top    = nearGaps[0];
      const offers = top.sides.map(s => `${s.guest} (${s.channel}${s.offer != null ? `, offer ${fmt$(s.offer)}` : ''})`).join(' or ');
      const more   = nearGaps.length > 1 ? ` (+${nearGaps.length - 1} more in the next 14 days)` : '';
      actions.push({
        level: 'gap', anchor: '#section-gaps', sectionLabel: 'Open Nights',
        text: `1-night gap ${fmtDateL(top.date)} — offer it to ${offers}.${more}`,
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
  const curRevTotal = (mtd?.cur ?? []).reduce((s, b) => s + (Number(b.gross_revenue) || 0), 0);
  const lyRevTotal  = (mtd?.ly ?? []).reduce((s, b) => s + (Number(b.gross_revenue) || 0), 0);
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

  const cards = summaries.map(({ prop, synopsis, actions, status }, i) => {
    const s = STATUS[status];
    const heading = groupHeading(prop, i);
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
    return `${heading}<div style="margin-bottom:10px;border-radius:8px;overflow:hidden;border:1px solid ${s.cardBorder};border-left:4px solid ${s.border};">${header}${syn}${body}</div>`;
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
  for (const p of plProps()) {
    data[p.plId] = {};
    const occ = occupiedSet(bookings, p.id);
    for (let i = 0; i < 90; i++) {
      const d = addDays(todayStr, i);
      if (occ.has(d)) continue;
      const dow = new Date(d + 'T00:00:00Z').getUTCDay();
      const isWknd = dow === 5 || dow === 6;
      const base = (BASE[p.id] ?? 150) * (isWknd ? 1.3 : 1) * (1 + i / 400);
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

// Run log row for this run (null for preview runs or if the run log write failed)
let RUN_ID = null;

async function main() {
  const todayStr = today();
  const t90 = addDays(todayStr, 90);
  const PREVIEW_OUT = ENV.PREVIEW_OUT;

  console.log(`Daily report for ${todayStr} (Arizona)${PREVIEW_OUT ? ' [PREVIEW MODE]' : ''} · ref ${GIT_REF} · ${TRIGGER_EVENT}${FORCE_SEND ? ' · forced' : ''}`);

  // ── Run log: skip if this ref already sent today (unless forced) ──────────
  if (!PREVIEW_OUT) {
    if (FORCE_SEND) {
      console.log('  Forced run: skipping the "already sent today" check');
    } else {
      // If the check itself fails, send anyway: a duplicate beats no report
      const sent = await step('Run log', () => alreadySentToday(todayStr));
      if (sent) {
        try { await startRunLog(todayStr, 'skipped'); }
        catch (e) { console.warn(`  Could not record the skipped run: ${e.message}`); }
        console.log(`  Already sent today from ${GIT_REF}; recorded as skipped. No email sent.`);
        return;
      }
    }
    RUN_ID = await step('Run log', () => startRunLog(todayStr, 'running'));
    await step('Run log', () => checkYesterdaySent(todayStr));
  }

  // ── Properties (required: without them there is no report) ───────────────
  PROPERTIES = await loadProperties();
  if (!PROPERTIES.length) throw new Error('No live properties found (onboarding_status live, active, OwnerRez ID set).');
  for (const p of PROPERTIES) {
    if (!p.plId) recordWarning('PriceLabs', `${p.name}: no PriceLabs listing linked; prices, alerts and forecast are skipped for it.`);
    if (!p.market) recordWarning('Events', `${p.name}: no event calendar for ${p.location || 'this market'}.`);
  }
  console.log(`  Properties: ${PROPERTIES.map(p => `${p.name} (${groupLabel(p)})`).join(', ')}`);

  const paceMonths = getPaceMonths(todayStr);
  const cachedEvents = fetchEventsCache(todayStr);
  const [activity, mtd, bookings, taxProfiles, paceData, forecastData, lastBookedMap] = await Promise.all([
    step('Recent activity', fetchRecentActivity),
    step('Month-to-date revenue', () => fetchMTDRevenue(todayStr)),
    step('Bookings (next 90 days)', () => fetchBookings90(todayStr, t90)),
    step('Tax profiles', fetchTaxProfiles),
    step('Booking pace', () => fetchBookingPaceData(paceMonths, todayStr)),
    step('Revenue forecast history', () => fetchRevenueForecastData(paceMonths, todayStr)),
    fetchLastBookedDates(),
  ]);
  // Open nights, gaps, prices and alerts all depend on the 90-day bookings
  if (!bookings) throw new Error('Bookings for the next 90 days could not be loaded.');
  const { tyBookings, lyBookings } = paceData ?? { tyBookings: null, lyBookings: null };
  const { tyBlocked, histActive, histBlocked } = forecastData ?? { tyBlocked: null, histActive: null, histBlocked: null };

  console.log(`  Bookings (90d): ${bookings.length} | New: ${activity?.newBookings.length ?? '—'} | Cancelled: ${activity?.cancellations.length ?? '—'} | MTD: ${mtd?.cur.length ?? '—'}`);
  console.log(`  Pace months: ${paceMonths.map(m => m.label).join(', ')} | TY: ${tyBookings?.length ?? '—'} bkgs | LY: ${lyBookings?.length ?? '—'} bkgs`);
  console.log(`  Forecast: ${histActive?.length ?? '—'} historical bookings | ${tyBlocked?.length ?? '—'} current-yr blocks`);

  // PriceLabs: file fallback (local only), then REST API, then preview sample
  let plData = loadPriceLabsFile();
  if (!plData) {
    console.log('  Fetching PriceLabs prices from API...');
    plData = await step('PriceLabs prices', () => fetchPriceLabsData(todayStr, t90));
  }
  if (!plData && PREVIEW_OUT) {
    console.log('  PriceLabs data: generating sample data for preview');
    recordWarning('PriceLabs prices', 'Preview is using made-up sample prices.');
    plData = buildSamplePlData(bookings, todayStr);
  }
  console.log(`  PriceLabs data: ${plData ? 'loaded (' + Object.keys(plData).length + ' listings)' : 'not available'}`);

  // Snapshot PriceLabs prices to Supabase for historical analysis
  if (plData && PRICELABS_KEY && !PREVIEW_OUT) {
    const before = failures.length;
    const n = await step('Price snapshot', () => snapshotPriceLabsData(plData, new Date().toISOString()));
    if (failures.length === before) console.log(`  ✓ pricing_snapshots: ${n} rows upserted`);
  }

  // Pricing alerts: listing settings + neighborhood market percentiles
  let alertData = null;
  if (PRICELABS_KEY && plData) {
    console.log('  Fetching pricing alert data (settings + market percentiles)...');
    alertData = await step('PriceLabs settings', fetchPricingAlertData);
  }

  // Alerts only: the report no longer writes pricing_actions (Build A, 6.4)

  const hardcodedEvents = getHardcodedEvents(todayStr);
  console.log(`  Events: ${hardcodedEvents.length} hardcoded + ${cachedEvents.length} from cache`);

  // Priority Action Board: per-property summary with action items
  console.log('  Building Priority Action Board...');
  const { summaries, portfolioNote } = buildPropertySummaries(
    plData, alertData, bookings, lastBookedMap,
    activity ?? { newBookings: [], cancellations: [] }, mtd,
    tyBookings ?? [], lyBookings ?? [], paceMonths, hardcodedEvents, cachedEvents, todayStr);
  const priorityBoardHtml = sectionPriorityBoard({ summaries, portfolioNote }, todayStr);
  const totalActions = summaries.reduce((n, s) => n + s.actions.length, 0);
  console.log(`  ✓ Priority Action Board: ${totalActions} action items across ${summaries.length} properties`);

  const sections = [
    mtd       ? sectionMTD(mtd, todayStr) : sectionUnavailable('section-mtd', '📊 Month-to-Date Revenue'),
    activity  ? sectionActivity(activity) : sectionUnavailable('section-activity', '🔔 Activity — Last 24 Hours'),
    sectionPricingAlerts(plData, alertData, bookings, todayStr),
    sectionSmartEvents(hardcodedEvents, cachedEvents, plData, histActive ?? [], todayStr),
    sectionOpenNights(bookings, todayStr, taxProfiles, plData),
    paceData  ? sectionBookingPace(tyBookings, lyBookings, paceMonths, todayStr) : sectionUnavailable('section-pace', '📈 Booking Pace vs Last Year'),
    paceData && forecastData
      ? sectionRevenueForecast(paceMonths, todayStr, tyBookings, tyBlocked, histActive, histBlocked, plData)
      : sectionUnavailable('section-forecast', '🔮 Revenue Forecast'),
    sectionPrices(bookings, plData, todayStr, alertData),
  ];

  // Banner is built last so it lists every failure recorded above
  const html = buildEmail(todayStr, sections, priorityBoardHtml, sectionStatusBanner());
  const subject = `${failures.length || warnings.length ? '[Issues] ' : ''}PPS Daily Report · ${fmtDateL(todayStr)}`;

  if (PREVIEW_OUT) {
    const { writeFileSync } = await import('fs');
    writeFileSync(PREVIEW_OUT, html);
    console.log(`  ✓ Preview written to: ${PREVIEW_OUT}`);
    return;
  }

  console.log('  Sending via Resend...');
  const result = await sendEmail(html, subject);
  console.log(`  ✓ Sent! ID: ${result.id}`);

  const status = failures.length ? 'sent_with_failures' : 'sent';
  try { await finishRunLog(RUN_ID, status, result.id); }
  catch (e) { recordFailure('Run log', e.message); }

  if (failures.length) {
    console.error(`  ${failures.length} step(s) failed (listed in the email banner); exiting 1 so the workflow shows red.`);
    process.exitCode = 1;
  }
}

// The report couldn't be built (or the email couldn't be sent): try a short
// failure email so the morning isn't silent, mark the run failed, exit 1.
async function handleFatal(err) {
  console.error('Fatal:', err);
  recordFailure('Report', err.message);
  const todayStr = today();
  if (!ENV.PREVIEW_OUT) {
    try {
      const body = `<h2 style="${H2}">The daily report couldn't be built today</h2>
        <p style="font-size:13px;color:#444;">Nothing else was sent. Check the GitHub Actions run${GITHUB_RUN_ID ? ` (run ${GITHUB_RUN_ID})` : ''} for details.</p>`;
      const html = buildEmail(todayStr, [body], '', sectionStatusBanner());
      const result = await sendEmail(html, `[Issues] PPS Daily Report FAILED · ${fmtDateL(todayStr)}`);
      console.error(`  Failure email sent: ${result.id}`);
    } catch (e) { console.error('  Failure email could not be sent:', e.message); }
    try { await finishRunLog(RUN_ID, 'failed', null); }
    catch (e) { console.error('  Run log update failed:', e.message); }
  }
  process.exit(1);
}

main().catch(handleFatal);
