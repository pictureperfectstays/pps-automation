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

// Cancellation dates are real only after this day. The Dec 30 2025 and Jan 12 2026
// groups were imported already cancelled (OwnerRez created = canceled timestamp),
// so for those we can't tell when they were cancelled.
const CANCELED_AT_TRUSTED_AFTER = '2026-01-12';
const canceledAtTrusted = b => !!b.canceled_at && b.canceled_at.slice(0, 10) > CANCELED_AT_TRUSTED_AFTER;

// Was this booking on the books at `snapshot` (ISO timestamp)? Active bookings made
// by then, plus bookings cancelled after it (only when the cancel date is trusted).
function onBooksAt(b, snapshot) {
  const at = Date.parse(snapshot);
  if (!b.booked_at || Date.parse(b.booked_at) > at) return false;
  if (b.status === 'active') return true;
  return b.status === 'canceled' && canceledAtTrusted(b) && Date.parse(b.canceled_at) > at;
}

// A booking as it stood at a past snapshot: a later-cancelled booking carries its
// last active gross (null when the portal didn't record it: amountMissing).
function asItStood(b) {
  if (b.status !== 'canceled') return b;
  return { ...b, gross_revenue: b.last_active_gross ?? 0, amountMissing: b.last_active_gross == null };
}

// Arizona end of a date, as a timestamp PostgREST and string compares both accept
const azEndOfDay = d => `${d}T23:59:59-07:00`;
const isoAt = ms => new Date(ms).toISOString();

// Last-year comparisons start the first full month after a property's first stay
// (a property whose first arrival is the 1st has that month as its first full month)
function firstFullMonth(firstArrival) {
  if (!firstArrival) return null;
  return firstArrival.slice(8, 10) === '01' ? isoMonthStart(firstArrival) : addMonths(isoMonthStart(firstArrival), 1);
}
const addMonths = (monthStart, n) => {
  const [y, m] = monthStart.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 10);
};
// Does the property have a comparable prior year for a period starting at lyStart?
const hasPriorYear = (prop, lyStart) => !prop.firstFullMonth || lyStart >= prop.firstFullMonth;

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

// departure gte today: a guest checking out today is the checkout side of tonight's gap
async function fetchBookings90(fromDate, toDate) {
  return sb(
    `bookings?select=id,property_id,status,guest_display_name,arrival_date,departure_date,nights,gross_revenue,net_revenue,booking_channel,booked_at,charges_json`
    + `&property_id=in.(${propIdList()})&status=in.(active,blocked)&arrival_date=lt.${toDate}&departure_date=gte.${fromDate}`
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

const CANCEL_SELECT = 'id,property_id,status,guest_display_name,arrival_date,departure_date,nights,gross_revenue,booking_channel,booked_at,canceled_at,last_active_gross,charges_json';

async function fetchRecentActivity() {
  const since = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
  const ids = propIdList();
  const [newBookings, cancelled] = await Promise.all([
    sb(`bookings?select=id,property_id,status,guest_display_name,arrival_date,departure_date,nights,gross_revenue,booking_channel,booked_at,charges_json&property_id=in.(${ids})&status=eq.active&booked_at=gte.${since}&order=booked_at.desc`),
    sb(`bookings?select=${CANCEL_SELECT}&property_id=in.(${ids})&status=eq.canceled&canceled_at=gte.${since}&order=canceled_at.desc`),
  ]);
  // Rebooked: active stays now on any of the cancelled nights, prorated to those nights
  const cancellations = await Promise.all(cancelled.map(async c => {
    const over = await sb(`bookings?select=id,guest_display_name,arrival_date,departure_date,nights,gross_revenue&property_id=eq.${c.property_id}&status=eq.active&arrival_date=lt.${c.departure_date}&departure_date=gt.${c.arrival_date}`);
    let rebookedNights = 0, rebookedGross = 0;
    for (const b of over) {
      const { revenue, nights } = prorateToMonth(b, c.arrival_date, c.departure_date);
      rebookedNights += nights; rebookedGross += revenue;
    }
    return { ...c, rebookedNights, rebookedGross };
  }));
  return { newBookings, cancellations };
}

// MTD split by night, gross, same rule as the portal dashboard
// (dashboard.js:1131-1158): each night of a stay counts gross / nights, and
// bookings at $0 or less are dropped. This month and the same month last year.
async function fetchMTDRevenue(todayStr) {
  const thisStart = isoMonthStart(todayStr);
  const thisEnd   = addMonths(thisStart, 1);
  const lyStart   = addMonths(thisStart, -12);
  const lyEnd     = addMonths(lyStart, 1);
  const lyCut     = addDays(lyStart, diffDays(thisStart, todayStr)); // same nights last year
  const ids       = propIdList();
  const q = (from, to) => sbAll(`bookings?select=id,property_id,arrival_date,departure_date,nights,gross_revenue&property_id=in.(${ids})&status=eq.active&gross_revenue=gt.0&arrival_date=lt.${to}&departure_date=gt.${from}&order=arrival_date.asc,id.asc`);
  const [cur, ly] = await Promise.all([q(thisStart, thisEnd), q(lyStart, lyEnd)]);
  return { cur, ly, thisStart, thisEnd, lyStart, lyEnd, lyCut, todayStr };
}

// Gross by night inside [from, to) per property: { [propId]: { gross, nights } }
function grossByNight(rows, from, to) {
  const r = {};
  for (const p of PROPERTIES) r[p.id] = { gross: 0, nights: 0 };
  for (const b of rows) {
    if (!r[b.property_id] || from >= to) continue;
    const { revenue, nights } = prorateToMonth(b, from, to);
    r[b.property_id].gross += revenue; r[b.property_id].nights += nights;
  }
  return r;
}

async function fetchBookingPaceData(paceMonths, todayStr) {
  // LY snapshot: end of the same date last year, Arizona time
  const lySnapshot   = azEndOfDay(addDays(todayStr, -365));
  const firstTYStart = paceMonths[0].start;
  const lastTYEnd    = paceMonths[paceMonths.length - 1].end;
  const firstLYStart = paceMonths[0].lyStart;
  const lastLYEnd    = paceMonths[paceMonths.length - 1].lyEnd;
  const ids          = propIdList();
  const [tyBookings, lyRows] = await Promise.all([
    sb(`bookings?select=property_id,arrival_date,departure_date,nights,gross_revenue&property_id=in.(${ids})&status=eq.active&arrival_date=lt.${lastTYEnd}&departure_date=gt.${firstTYStart}&order=arrival_date.asc`),
    sbAll(`bookings?select=${CANCEL_SELECT}&property_id=in.(${ids})&status=in.(active,canceled)&booked_at=lte.${lySnapshot}&arrival_date=lt.${lastLYEnd}&departure_date=gt.${firstLYStart}&order=arrival_date.asc,id.asc`),
  ]);
  // LY as it stood on the snapshot date, including stays cancelled later
  const lyBookings = lyRows.filter(b => onBooksAt(b, lySnapshot)).map(asItStood);
  return {
    tyBookings, lyBookings,
    lyNightsApprox: lySnapshot.slice(0, 10) <= CANCELED_AT_TRUSTED_AFTER,
    lyAmountsMissing: lyBookings.filter(b => b.amountMissing).length,
  };
}

// Pickup: bookings made in the last 7 and 15 days that are on the books today,
// vs bookings made in the same windows last year that were on the books then
async function fetchPickupData() {
  const now = Date.now(), DAY = 86400000;
  const lyNow = now - 365 * DAY;
  const ids = propIdList();
  const [ty, lyRows] = await Promise.all([
    sb(`bookings?select=property_id,nights,gross_revenue,booked_at&property_id=in.(${ids})&status=eq.active&booked_at=gte.${isoAt(now - 15 * DAY)}`),
    sb(`bookings?select=${CANCEL_SELECT}&property_id=in.(${ids})&status=in.(active,canceled)&booked_at=gte.${isoAt(lyNow - 15 * DAY)}&booked_at=lte.${isoAt(lyNow)}`),
  ]);
  const ly = lyRows.filter(b => onBooksAt(b, isoAt(lyNow))).map(asItStood);
  return { ty, ly, tyFrom7: isoAt(now - 7 * DAY), lyFrom7: isoAt(lyNow - 7 * DAY), lyAmountsMissing: ly.filter(b => b.amountMissing).length };
}

async function fetchRevenueForecastData(paceMonths, todayStr) {
  const firstStart = paceMonths[0].start;
  const lastEnd    = paceMonths[paceMonths.length - 1].end;
  const ids        = propIdList();

  // Current-year blocks for forecast months + all history through today, so
  // next-year months have last year's month (e.g. January 2026 for January 2027).
  // History paged until complete — no row cap.
  const [tyBlocked, histActive, histBlocked] = await Promise.all([
    sbAll(`bookings?select=property_id,arrival_date,departure_date&property_id=in.(${ids})&status=eq.blocked&arrival_date=lt.${lastEnd}&departure_date=gt.${firstStart}&order=arrival_date.asc,id.asc`),
    sbAll(`bookings?select=property_id,arrival_date,departure_date,nights,gross_revenue,booked_at&property_id=in.(${ids})&status=eq.active&arrival_date=lt.${todayStr}&order=arrival_date.asc,id.asc`),
    sbAll(`bookings?select=property_id,arrival_date,departure_date&property_id=in.(${ids})&status=eq.blocked&arrival_date=lt.${todayStr}&order=arrival_date.asc,id.asc`),
  ]);

  return { tyBlocked, histActive, histBlocked };
}

// Each property's first stay (for the first-full-month rule)
async function fetchFirstArrivals() {
  const rows = await Promise.all(PROPERTIES.map(p =>
    sb(`bookings?select=arrival_date&property_id=eq.${p.id}&status=eq.active&order=arrival_date.asc&limit=1`)
      .then(r => [p.id, r[0]?.arrival_date ?? null])));
  return Object.fromEntries(rows);
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

const JUNK_EVENT_NAME = /^\s*events from\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b/i;

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
    // Web-search entries named after a listing page ("Events from July 9") aren't events
    const events = (data.events || []).filter(ev => !JUNK_EVENT_NAME.test(ev.name || ''));
    const junk = (data.events || []).length - events.length;
    if (junk) console.log(`  Events cache: skipped ${junk} listing-page entr${junk !== 1 ? 'ies' : 'y'} ("Events from [date]")`);
    return events;
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

  // Every past year whose event window has fully happened (history runs through today,
  // so a January 2027 event uses January 2026 too)
  const eventYear = parseInt(event.start_date.slice(0, 4));
  for (let yr = earliest; yr < Math.max(currentYear, eventYear); yr++) {
    // Build the event window for this historical year, accounting for cross-year events
    const evStart = `${yr}-${eventMonth}-${eventDay}`;
    const endYear = event.end_date.slice(5, 7) < event.start_date.slice(5, 7) ? yr + 1 : yr;
    const evEnd   = addDays(`${endYear}-${eventMonthE}-${eventDayE}`, 1); // exclusive end
    if (evEnd > today()) continue;

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
    const pickupFields = Object.keys(allSettings[0] || {}).filter(k => /pick|stly|book/i.test(k));
    console.log(`  PriceLabs listing fields matching pickup/booking: ${pickupFields.join(', ') || 'none'}`);
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

// "Listings Used" for a bedroom category. PriceLabs puts it in each category,
// next to X_values / Y_values: data["Market KPI"].Category[<bedrooms>]["Listings Used"].
// If it isn't there, a search for a matching key (in the section, then anywhere
// in the response, as a number or an object keyed by bedroom count) is the
// fallback, with a warning. The top-level data["Listings Used"] is the total
// across all bedroom categories and is never used.
// Returns { value, path, fallback } or null.
function findListingsUsed(marketData, kpi, category, bedroomKey, propName) {
  const direct = Number(category?.['Listings Used']);
  if (category?.['Listings Used'] != null && Number.isFinite(direct)) return { value: direct, path: `Market KPI.Category.${bedroomKey}.Listings Used`, fallback: false };
  const found = searchListingsUsed(marketData, kpi, category, bedroomKey);
  if (found) recordWarning('Market pickup', `${propName}: "Listings Used" not in the ${bedroomKey}-bedroom category; used ${found.value} from ${found.path} instead.`);
  return found ? { ...found, fallback: true } : null;
}
function searchListingsUsed(marketData, kpi, category, bedroomKey) {
  const RX = /listings\s*_?\s*used/i;
  const isTopLevelTotal = (path, v) => path === 'response.data' && typeof v !== 'object';
  const asNumber = v => {
    if (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v)))) return Number(v);
    if (Array.isArray(v)) return asNumber(v.flat(Infinity)[0]);
    if (v && typeof v === 'object') return asNumber(v[bedroomKey] ?? v.Category?.[bedroomKey]);
    return null;
  };
  const search = (obj, path, depth) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj) || depth > 4) return null;
    for (const [k, v] of Object.entries(obj)) {
      if (RX.test(k) && !isTopLevelTotal(path, v)) { const n = asNumber(v); if (n != null) return { value: n, path: `${path}.${k}` }; }
    }
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'Category' && v?.[bedroomKey]) { const r = search(v[bedroomKey], `${path}.Category.${bedroomKey}`, depth + 1); if (r) return r; continue; }
      if (k === 'Category') continue; // other bedroom counts
      const r = search(v, `${path}.${k}`, depth + 1); if (r) return r;
    }
    return null;
  };
  return search(category, 'category', 0) || search(kpi, 'kpi', 0) || search(marketData, 'response', 0);
}

// Market 7-day pickup from neighborhood_data "Market KPI", series matched by
// label, for the property's bedroom category.
// PriceLabs puts forward-looking series (Future Booked Days, STLY, 7 Day Pickup)
// for month M in the row labelled M minus 12 months. The offset is checked on
// every run: Future Booked Days in the offset row must equal Total Booked Days
// in the current month's row; otherwise the column is left blank with a warning.
// Pickup is summed over every forward month (current month onward), the same
// scope as our own pickup (bookings made in the window, any stay dates), and
// shown in nights per listing (÷ the category's "Listings Used").
// Returns { pickup, stly, listings, perListing, stlyPerListing, thisMonth } or
// null; logs the inputs.
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function parseMarketPickup(marketData, bedroomCount, propName, todayStr) {
  const kpiKey = Object.keys(marketData?.data || {}).find(k => /market\s*kpi/i.test(k));
  const kpi = kpiKey ? marketData.data[kpiKey] : null;
  const warn = detail => { recordWarning('Market pickup', `${propName}: ${detail}; market column left blank.`); return null; };
  if (!kpi?.Category) {
    console.log(`  Market pickup for ${propName}: no "Market KPI" in neighborhood data (sections: ${Object.keys(marketData?.data || {}).join(', ')})`);
    return warn('no "Market KPI" in PriceLabs neighborhood data');
  }
  const category = marketCategory(kpi, kpiKey, bedroomCount, propName);
  if (!category) return warn('no bedroom category in "Market KPI"');
  const yVals = category.Y_values || [];
  const isLabelList = v => Array.isArray(v) && v.length === yVals.length && v.every(x => typeof x === 'string');
  const labels = [category, kpi].flatMap(o => Object.values(o || {})).find(isLabelList) || [];
  const idx = rx => labels.findIndex(l => rx.test(l));
  const iPick   = idx(/^\s*7\s*day\s*pickup\s*$/i);
  const iStly   = idx(/^\s*7\s*day\s*pickup\s*stly\s*$/i);
  const iTotal  = idx(/^\s*total\s*booked\s*days\s*$/i);
  const iFuture = idx(/^\s*future\s*booked\s*days\s*$/i);
  const months = (category.X_values || []).map(String);
  const first = v => (Array.isArray(v) ? first(v[0]) : v); // some series are nested
  const valueAt = (si, mi) => (si < 0 || mi < 0 ? null : first((yVals[si] || [])[mi]) ?? null);

  const [y, m] = todayStr.split('-').map(Number);
  const curLabel = `${MONTH_ABBR[m - 1]} ${y}`, offLabel = `${MONTH_ABBR[m - 1]} ${y - 1}`;
  const cur = months.findIndex(x => x.trim() === curLabel);
  const off = months.findIndex(x => x.trim() === offLabel);
  // Forward rows: the offset row through the last month-labelled row
  const isMonth = x => /^[A-Za-z]{3}\s+\d{4}$/.test(x.trim());
  let lastMonthRow = off;
  while (lastMonthRow + 1 < months.length && isMonth(months[lastMonthRow + 1])) lastMonthRow++;

  const listings = findListingsUsed(marketData, kpi, category, String(bedroomCount), propName);
  const futureOff = valueAt(iFuture, off), totalCur = valueAt(iTotal, cur);
  console.log(`  Market pickup for ${propName}: rows ${offLabel} (offset) / ${curLabel} (current) · Future Booked Days ${futureOff} vs Total Booked Days ${totalCur} · Listings Used ${listings ? `${listings.value} at ${listings.path}` : 'not found'} · 7 Day Pickup ${JSON.stringify((yVals[iPick] || []).map(first))} · STLY ${JSON.stringify((yVals[iStly] || []).map(first))}`);
  if (!listings) console.log(`    response keys: ${JSON.stringify(Object.keys(marketData || {}))} · data keys: ${JSON.stringify(Object.keys(marketData?.data || {}))} · ${kpiKey} keys: ${JSON.stringify(Object.keys(kpi))} · category keys: ${JSON.stringify(Object.keys(category))}`);

  if (iPick < 0) return warn('no "7 Day Pickup" series');
  if (cur < 0 || off < 0) return warn(`month rows ${curLabel} / ${offLabel} not found`);
  if (iTotal < 0 || iFuture < 0) return warn('"Total Booked Days" / "Future Booked Days" series missing, so the 12-month offset can\'t be checked');
  if (futureOff == null || totalCur == null || Math.abs(Number(futureOff) - Number(totalCur)) >= 0.5)
    return warn(`12-month offset check failed (Future Booked Days in ${offLabel} = ${futureOff}, Total Booked Days in ${curLabel} = ${totalCur})`);
  if (!listings || !(listings.value > 0)) return warn('"Listings Used" not found in PriceLabs neighborhood data');

  let pickup = 0, stly = 0, stlyFound = iStly >= 0;
  for (let r = off; r <= lastMonthRow; r++) {
    pickup += Number(valueAt(iPick, r)) || 0;
    if (stlyFound) stly += Number(valueAt(iStly, r)) || 0;
  }
  return {
    pickup, stly: stlyFound ? stly : null, listings: listings.value,
    perListing: pickup / listings.value,
    stlyPerListing: stlyFound ? stly / listings.value : null,
    thisMonth: Number(valueAt(iPick, off)) || 0,
  };
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

// ─── Revenue Forecast ────────────────────────────────────────────────────────

function computeLYActual(prop, paceMonth, histActive) {
  let revenue = 0;
  for (const b of histActive) {
    if (b.property_id !== prop.id) continue;
    revenue += prorateToMonth(b, paceMonth.lyStart, paceMonth.lyEnd).revenue;
  }
  return revenue;
}

// Booked gross ÷ PriceLabs price, per property, over booked nights in the next 90
// days (today's PriceLabs prices cover booked nights too). Gross carries cleaning,
// taxes and channel markup, so open nights × PriceLabs price × this ratio is on the
// same basis as confirmed gross and last year's gross. Needs FORECAST_RATIO_MIN_NIGHTS
// priced booked nights and a ratio within FORECAST_RATIO_RANGE; otherwise the
// portfolio ratio (from properties that pass both) is used.
const FORECAST_RATIO_MIN_NIGHTS = 7;
const FORECAST_RATIO_RANGE = [0.8, 2.0];
// Years of late-booked history used to cap the value of an open night
const LATE_ADR_YEARS = 3;
function bookedPriceRatios(bookings, plData, todayStr) {
  const t90 = addDays(todayStr, 90);
  const sums = {};
  let allGross = 0, allPrice = 0;
  for (const p of PROPERTIES) {
    const prices = plData?.[p.plId];
    sums[p.id] = { gross: 0, price: 0, nights: 0 };
    if (!prices) continue;
    for (const b of bookings) {
      if (b.property_id !== p.id || b.status !== 'active' || !(Number(b.gross_revenue) > 0)) continue;
      const perNight = Number(b.gross_revenue) / (b.nights || Math.max(1, diffDays(b.arrival_date, b.departure_date)));
      let d = b.arrival_date < todayStr ? todayStr : b.arrival_date;
      while (d < b.departure_date && d < t90) {
        if (prices[d]?.price > 0) { sums[p.id].gross += perNight; sums[p.id].price += prices[d].price; sums[p.id].nights++; }
        d = addDays(d, 1);
      }
    }
  }
  const own = p => (sums[p.id].price > 0 ? sums[p.id].gross / sums[p.id].price : null);
  const inRange = r => r != null && r >= FORECAST_RATIO_RANGE[0] && r <= FORECAST_RATIO_RANGE[1];
  for (const p of PROPERTIES) {
    if (sums[p.id].nights >= FORECAST_RATIO_MIN_NIGHTS && inRange(own(p))) { allGross += sums[p.id].gross; allPrice += sums[p.id].price; }
  }
  const portfolio = allPrice > 0 ? allGross / allPrice : null;
  const out = {};
  for (const p of PROPERTIES) {
    const s = sums[p.id], r = own(p);
    out[p.id] = s.nights < FORECAST_RATIO_MIN_NIGHTS ? { ratio: portfolio, own: r, nights: s.nights, source: 'few_nights' }
      : !inRange(r) ? { ratio: portfolio, own: r, nights: s.nights, source: 'out_of_range' }
      : { ratio: r, own: r, nights: s.nights, source: 'own' };
  }
  return out;
}

// Same calendar date `years` earlier (Feb 29 → Feb 28)
function shiftYears(dateStr, years) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const last = new Date(Date.UTC(y - years, m, 0)).getUTCDate();
  return `${y - years}-${String(m).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

// Core fill-rate + projection engine for one property × one forecast month.
function computePropertyForecast(prop, paceMonth, todayStr, tyBookings, tyBlocked, histActive, histBlocked, plData, ratioInfo) {
  const monthYear   = parseInt(paceMonth.start.slice(0, 4));
  const monthNum    = parseInt(paceMonth.start.split('-')[1]);
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
    : monthYear - 1;

  const fillRates        = [];
  const fullyBookedYears = [];
  const lyMonthStr       = String(monthNum).padStart(2, '0');

  // Every earlier year of this month, counted from the forecast month's own year
  // (January 2027 starts at January 2026)
  for (let yr = monthYear - 1; yr >= earliestYear; yr--) {
    const lyStart = `${yr}-${lyMonthStr}-01`;
    const lyEnd   = new Date(Date.UTC(yr, monthNum, 1)).toISOString().slice(0, 10);
    const lyDays  = diffDays(lyStart, lyEnd);
    if (lyStart < (prop.firstFullMonth || '')) continue; // before the first full month

    // Same calendar point: today, shifted back as many years as this month is
    const samePoint = shiftYears(todayStr, monthYear - yr);

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

    // Total nights confirmed by month-end; nights booked after the same point
    // also record what they earned (stay gross ÷ nights)
    const lyTotalDates = new Set();
    let lateNights = 0, lateGross = 0;
    for (const b of lyMonthBookings) {
      const late = !b.booked_at || b.booked_at.slice(0, 10) > samePoint;
      const perNight = b.nights > 0 ? (Number(b.gross_revenue) || 0) / b.nights : 0;
      let dt = b.arrival_date < lyStart ? lyStart : b.arrival_date;
      while (dt < b.departure_date && dt < lyEnd) {
        lyTotalDates.add(dt);
        if (late && !lyAtPointDates.has(dt)) { lateNights++; lateGross += perNight; }
        dt = addDays(dt, 1);
      }
    }

    const lyOpenAtPoint = Math.max(0, lyAvailable - lyAtPointDates.size);

    if (lyOpenAtPoint === 0) {
      fullyBookedYears.push(yr);
      continue;
    }

    const lyFilled  = Math.max(0, lyTotalDates.size - lyAtPointDates.size);
    const fillRate  = Math.min(1.0, lyFilled / lyOpenAtPoint);
    fillRates.push({ yr, fillRate, openAtPoint: lyOpenAtPoint, filled: lyFilled, lateNights, lateGross });
  }

  // What late-booked nights earned in this month: pooled over the most recent
  // LATE_ADR_YEARS fill-rate years that had late bookings (fewer if that's all
  // the history there is)
  const lateYears = fillRates.filter(r => r.lateNights > 0).slice(0, LATE_ADR_YEARS);
  const lateNightsSum = lateYears.reduce((s, r) => s + r.lateNights, 0);
  const lateADR = lateNightsSum > 0 ? lateYears.reduce((s, r) => s + r.lateGross, 0) / lateNightsSum : null;
  const lateADRYears = lateYears.map(r => r.yr);

  // LY actual revenue (no booked_at filter — final month-end result); null before
  // the property's first full month
  const lyActualRevenue = hasPriorYear(prop, paceMonth.lyStart) ? computeLYActual(prop, paceMonth, histActive) : null;

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

  // Open nights valued at the average PriceLabs price × the property's booked-gross ratio
  const propPrices      = plData?.[prop.plId] || {};
  const pricedOpenDates = openDates.filter(d => propPrices[d]?.price > 0);
  const avgPLPrice      = pricedOpenDates.length > 0
    ? pricedOpenDates.reduce((s, d) => s + propPrices[d].price, 0) / pricedOpenDates.length
    : null;
  const plValue  = avgPLPrice != null && ratioInfo?.ratio ? avgPLPrice * ratioInfo.ratio : null;
  // Valued at the lower of today's price × ratio and what late-booked nights earned
  const priceCapped = plValue != null && lateADR != null && lateADR < plValue;
  const avgPrice    = priceCapped ? lateADR : plValue;

  // Expected nights filled (base) vs nights filled after this point in past years
  const expectedNights = openNights * Math.min(1.0, avgFillRate);
  const pastFilled     = fillRates.map(r => r.filled);
  const pastRange      = pastFilled.length ? [Math.min(...pastFilled), Math.max(...pastFilled)] : null;

  const scenario = (mult) => {
    if (openNights === 0) return confirmedRevenue; // Fully booked — confirmed is the projection
    if (avgPrice == null) return null;             // Can't project without prices
    return confirmedRevenue + openNights * Math.min(1.0, avgFillRate * mult) * avgPrice;
  };

  const conservative  = scenario(0.5);
  const base          = scenario(1.0);
  const optimistic    = scenario(1.3);
  const isFullyBooked = openNights === 0;
  const isRedFlag     = base != null && lyActualRevenue != null && lyActualRevenue > 0 && base < lyActualRevenue * 0.85;

  return {
    prop, paceMonth, confirmedRevenue, confirmedNights, openNights, availableDays,
    avgFillRate, avgPrice, plValue, lateADR, lateADRYears, priceCapped,
    expectedNights, pastRange, fillRates, fullyBookedYears,
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

// MTD by night, gross (dashboard rule). Earned = nights before today; rest of
// month = nights from today on. Last year: the same nights of last year's month,
// and its full month. Before a property's first full month: "No prior year".
function mtdFigures(mtd) {
  const earned = grossByNight(mtd.cur, mtd.thisStart, mtd.todayStr);
  const rest   = grossByNight(mtd.cur, mtd.todayStr, mtd.thisEnd);
  const lySame = grossByNight(mtd.ly, mtd.lyStart, mtd.lyCut);
  const lyFull = grossByNight(mtd.ly, mtd.lyStart, mtd.lyEnd);
  const out = {};
  for (const p of PROPERTIES) {
    const prior = hasPriorYear(p, mtd.lyStart);
    out[p.id] = { earned: earned[p.id], rest: rest[p.id], lySame: prior ? lySame[p.id] : null, lyFull: prior ? lyFull[p.id] : null };
  }
  return out;
}

function sectionMTD(mtd, todayStr) {
  const fig = mtdFigures(mtd);
  const monthLabel = new Date(mtd.thisStart + 'T00:00:00Z')
    .toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const yoyCell = (cur, ly, bold) => {
    const yoy = ly ? (cur - ly) / ly * 100 : null;
    const color = yoy == null ? '#999' : yoy >= 0 ? '#1a7f5a' : '#c0392b';
    return `<td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;text-align:right;${bold ? 'font-weight:700;' : 'font-weight:600;'}color:${color};">${yoy == null ? '—' : `${yoy >= 0 ? '+' : ''}${Math.round(yoy)}%`}</td>`;
  };
  const NO_PY = '<span style="font-size:11px;color:#aaa;">No prior year</span>';
  const TDR = 'padding:8px 12px;border-bottom:1px solid #f0f0f0;text-align:right;';

  let rows = '';
  const tot = { earned: 0, rest: 0, cmpEarned: 0, lySame: 0, lyFull: 0 };
  const noPrior = [];
  PROPERTIES.forEach((p, i) => {
    const f = fig[p.id];
    tot.earned += f.earned.gross; tot.rest += f.rest.gross;
    if (f.lySame) { tot.cmpEarned += f.earned.gross; tot.lySame += f.lySame.gross; tot.lyFull += f.lyFull.gross; }
    else noPrior.push(p.name);
    rows += groupRow(p, i, 6) + `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;">${tag(p)}</td>
      <td style="${TDR}font-weight:600;">${fmt$(f.earned.gross)}<div style="font-size:10px;color:#aaa;font-weight:400;">${f.earned.nights} nts</div></td>
      <td style="${TDR}color:#666;">${f.lySame ? fmt$(f.lySame.gross) : NO_PY}</td>
      ${f.lySame ? yoyCell(f.earned.gross, f.lySame.gross) : `<td style="${TDR}color:#999;">—</td>`}
      <td style="${TDR}">${fmt$(f.rest.gross)}<div style="font-size:10px;color:#aaa;">${f.rest.nights} nts</div></td>
      <td style="${TDR}color:#666;">${f.lyFull ? fmt$(f.lyFull.gross) : NO_PY}</td>
    </tr>`;
  });
  const excl = noPrior.length ? `<div style="font-size:10px;color:#aaa;font-weight:400;">excl. ${noPrior.join(', ')}</div>` : '';
  rows += `<tr style="background:#f8f9fa;">
    <td style="padding:8px 12px;font-weight:700;">Portfolio Total</td>
    <td style="padding:8px 12px;text-align:right;font-weight:700;">${fmt$(tot.earned)}</td>
    <td style="padding:8px 12px;text-align:right;color:#666;">${fmt$(tot.lySame)}${excl}</td>
    ${yoyCell(tot.cmpEarned, tot.lySame, true)}
    <td style="padding:8px 12px;text-align:right;font-weight:700;">${fmt$(tot.rest)}</td>
    <td style="padding:8px 12px;text-align:right;color:#666;">${fmt$(tot.lyFull)}${excl}</td>
  </tr>`;

  const throughLabel = todayStr > mtd.thisStart ? `${fmtDate(mtd.thisStart)}–${fmtDate(addDays(todayStr, -1))}` : 'none yet';
  return `<h2 id="section-mtd" style="${H2}">📊 Month-to-Date Revenue — ${monthLabel}</h2>
  <table style="width:100%;border-collapse:collapse;font-size:13px;">
    <tr style="background:#f8f9fa;">
      <th style="${TH}">Property</th>
      <th style="${TH}text-align:right;">Earned<br><span style="font-weight:400;font-size:10px;">${throughLabel}</span></th>
      <th style="${TH}text-align:right;">Same Nights LY</th><th style="${TH}text-align:right;">YoY</th>
      <th style="${TH}text-align:right;">Booked Rest<br><span style="font-weight:400;font-size:10px;">of month</span></th>
      <th style="${TH}text-align:right;">LY Full Month</th>
    </tr>${rows}
  </table>
  <p style="font-size:11px;color:#aaa;margin:8px 0 0;">Gross by night, same as the portal dashboard: each night of a stay counts the stay's gross ÷ nights; $0 bookings are excluded. Earned = nights before today; Booked Rest = nights from today to month-end already on the books. Last year compares the same nights of ${new Date(mtd.lyStart + 'T00:00:00Z').toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })}.${noPrior.length ? ` Portfolio YoY excludes properties with no prior year.` : ''}</p>`;
}

// Pickup: bookings made in the last 7 / 15 days (count + gross) vs the same windows
// last year. Zero pickup for 14+ days is flagged.
function pickupTable(pickup, lastBookedMap, marketPickup) {
  const win = (rows, from7) => {
    const r = {};
    for (const p of PROPERTIES) r[p.id] = { n7: 0, nt7: 0, g7: 0, n15: 0, nt15: 0, g15: 0 };
    for (const b of rows) {
      const x = r[b.property_id]; if (!x) continue;
      const g = Number(b.gross_revenue) || 0, nt = Number(b.nights) || 0;
      x.n15++; x.nt15 += nt; x.g15 += g;
      if (Date.parse(b.booked_at) >= Date.parse(from7)) { x.n7++; x.nt7 += nt; x.g7 += g; }
    }
    return r;
  };
  const ty = win(pickup.ty, pickup.tyFrom7), ly = win(pickup.ly, pickup.lyFrom7);
  const lyWindowStart = isoAt(Date.parse(pickup.lyFrom7) - 8 * 86400000).slice(0, 10);
  const cell = (n, nt, g) => `${n} · ${nt} nt${nt !== 1 ? 's' : ''} · ${fmt$(g)}`;
  const TDR = 'padding:7px 12px;border-bottom:1px solid #f0f0f0;text-align:right;';
  const NO_PY = '<span style="font-size:11px;color:#aaa;">No prior year</span>';
  const zero = () => ({ n7: 0, nt7: 0, g7: 0, n15: 0, nt15: 0, g15: 0 });
  const tot = { ty: zero(), ly: zero() };
  let rows = '';
  PROPERTIES.forEach((p, i) => {
    const t = ty[p.id], l = ly[p.id];
    const prior = hasPriorYear(p, lyWindowStart);
    for (const k of Object.keys(t)) { tot.ty[k] += t[k]; if (prior) tot.ly[k] += l[k]; }
    const last = lastBookedMap?.[p.id];
    const quietDays = last ? Math.floor((Date.now() - Date.parse(last)) / 86400000) : null;
    const flag = quietDays != null && quietDays >= 14
      ? `<div style="font-size:10px;color:#c0392b;font-weight:600;">No new bookings in ${quietDays} days</div>` : '';
    const mk = marketPickup?.[p.id];
    const oneDp = v => (Math.round(v * 10) / 10).toFixed(1);
    const mkCell = mk?.perListing != null
      ? `${oneDp(mk.perListing)} nts${mk.stlyPerListing != null ? `<div style="font-size:10px;color:#aaa;">STLY ${oneDp(mk.stlyPerListing)}</div>` : ''}`
      : '<span style="font-size:11px;color:#aaa;">—</span>';
    rows += groupRow(p, i, 6) + `<tr>
      <td style="padding:7px 12px;border-bottom:1px solid #f0f0f0;">${tag(p)}${flag}</td>
      <td style="${TDR}font-weight:600;">${cell(t.n7, t.nt7, t.g7)}</td>
      <td style="${TDR}color:#666;">${prior ? cell(l.n7, l.nt7, l.g7) : NO_PY}</td>
      <td style="${TDR}font-weight:600;">${cell(t.n15, t.nt15, t.g15)}</td>
      <td style="${TDR}color:#666;">${prior ? cell(l.n15, l.nt15, l.g15) : NO_PY}</td>
      <td style="${TDR}">${mkCell}</td>
    </tr>`;
  });
  rows += `<tr style="background:#f8f9fa;">
    <td style="padding:7px 12px;font-weight:700;">Portfolio Total</td>
    <td style="padding:7px 12px;text-align:right;font-weight:700;">${cell(tot.ty.n7, tot.ty.nt7, tot.ty.g7)}</td>
    <td style="padding:7px 12px;text-align:right;color:#666;">${cell(tot.ly.n7, tot.ly.nt7, tot.ly.g7)}</td>
    <td style="padding:7px 12px;text-align:right;font-weight:700;">${cell(tot.ty.n15, tot.ty.nt15, tot.ty.g15)}</td>
    <td style="padding:7px 12px;text-align:right;color:#666;">${cell(tot.ly.n15, tot.ly.nt15, tot.ly.g15)}</td>
    <td style="padding:7px 12px;"></td>
  </tr>`;
  const missing = pickup.lyAmountsMissing
    ? ` ${pickup.lyAmountsMissing} last-year booking${pickup.lyAmountsMissing !== 1 ? 's were' : ' was'} cancelled later with no recorded amount; counted, but at $0.` : '';
  return `<div style="margin-bottom:20px;">
    <div style="font-size:13px;font-weight:700;color:#444;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid #eee;">Pickup — new bookings</div>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <tr style="background:#f8f9fa;">
        <th style="${TH}">Property</th>
        <th style="${TH}text-align:right;">Last 7 Days</th><th style="${TH}text-align:right;">Same 7 LY</th>
        <th style="${TH}text-align:right;">Last 15 Days</th><th style="${TH}text-align:right;">Same 15 LY</th>
        <th style="${TH}text-align:right;">Market 7-Day<br><span style="font-weight:400;font-size:10px;">nights per listing</span></th>
      </tr>${rows}
    </table>
    <p style="font-size:11px;color:#aaa;margin:6px 0 0;">Bookings made in the window and still on the books (bookings · nights · full-stay gross). Last year counts bookings made in the same windows that were on the books then, including ones cancelled later. Market 7-Day = PriceLabs "7 Day Pickup" for the property's bedroom category, all stay months from this month on, ÷ the category's listings, so it compares with our Last 7 Days nights (one listing). STLY = same time last year, ÷ today's listing count.${missing}</p>
  </div>`;
}

function sectionBookingPace(paceData, paceMonths, todayStr, pickup, lastBookedMap, marketPickup) {
  const { tyBookings, lyBookings } = paceData;
  const lySnapshotLabel = fmtDate(addDays(todayStr, -365));
  let html = `<h2 id="section-pace" style="${H2}">📈 Booking Pace vs Last Year</h2>`;
  html += pickup ? pickupTable(pickup, lastBookedMap, marketPickup) : '';

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

  const accuracy = [];
  if (paceData.lyNightsApprox)
    accuracy.push(`Last year's nights are approximate: cancellations recorded on or before ${fmtDate(CANCELED_AT_TRUSTED_AFTER)}, ${CANCELED_AT_TRUSTED_AFTER.slice(0, 4)} have no real cancel date, so stays cancelled after ${lySnapshotLabel} last year can be missing`);
  if (paceData.lyAmountsMissing)
    accuracy.push(`${paceData.lyAmountsMissing} last-year booking${paceData.lyAmountsMissing !== 1 ? 's were' : ' was'} on the books then but cancelled later with no recorded amount; the nights count but the revenue shows as $0, so last year's revenue is understated`);
  const accuracyStr = accuracy.length ? ` ${accuracy.join('. ')}.` : '';

  html += `<p style="font-size:12px;color:#888;margin:0 0 16px;">On the books today vs. on the books on ${lySnapshotLabel} last year, including stays cancelled after that date — not LY final actuals.${contextStr}${accuracyStr}</p>`;

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
    let totTYRev = 0, totLYRev = 0, totTYNts = 0, totLYNts = 0, cmpTYRev = 0;
    const noPrior = [];
    PROPERTIES.forEach((p, i) => {
      const prior = hasPriorYear(p, month.lyStart);
      const tyRev = ty[p.id].revenue, lyRev = prior ? ly[p.id].revenue : null;
      const tyNts = ty[p.id].nights,  lyNts = prior ? ly[p.id].nights : null;
      totTYRev += tyRev; totTYNts += tyNts;
      if (prior) { totLYRev += lyRev; totLYNts += lyNts; cmpTYRev += tyRev; } else noPrior.push(p.name);
      const yoy      = lyRev > 0 ? (tyRev - lyRev) / lyRev * 100 : null;
      const yoyStr   = yoy != null ? `${yoy >= 0 ? '+' : ''}${Math.round(yoy)}%` : '—';
      const yoyColor = yoy == null ? '#999' : yoy >= 5 ? '#1a7f5a' : yoy < -5 ? '#c0392b' : '#e67e22';
      rows += groupRow(p, i, 5) + `<tr>
        <td style="padding:7px 12px;border-bottom:1px solid #f0f0f0;">${tag(p)}</td>
        <td style="padding:7px 12px;border-bottom:1px solid #f0f0f0;text-align:right;font-weight:600;">${fmt$(Math.round(tyRev))}</td>
        <td style="padding:7px 12px;border-bottom:1px solid #f0f0f0;text-align:right;color:#666;">${prior ? fmt$(Math.round(lyRev)) : '<span style="font-size:11px;color:#aaa;">No prior year</span>'}</td>
        <td style="padding:7px 12px;border-bottom:1px solid #f0f0f0;text-align:right;font-weight:600;color:${yoyColor};">${yoyStr}</td>
        <td style="padding:7px 12px;border-bottom:1px solid #f0f0f0;text-align:right;color:#888;font-size:12px;">${Math.round(tyNts)}n / ${prior ? Math.round(lyNts) + 'n' : '—'}</td>
      </tr>`;
    });
    const totYoY    = totLYRev > 0 ? (cmpTYRev - totLYRev) / totLYRev * 100 : null;
    const totYoYStr = totYoY != null ? `${totYoY >= 0 ? '+' : ''}${Math.round(totYoY)}%` : '—';
    const totColor  = totYoY == null ? '#999' : totYoY >= 5 ? '#1a7f5a' : totYoY < -5 ? '#c0392b' : '#e67e22';
    rows += `<tr style="background:#f8f9fa;">
      <td style="padding:7px 12px;font-weight:700;">Portfolio Total</td>
      <td style="padding:7px 12px;text-align:right;font-weight:700;">${fmt$(Math.round(totTYRev))}</td>
      <td style="padding:7px 12px;text-align:right;color:#666;">${fmt$(Math.round(totLYRev))}${noPrior.length ? `<div style="font-size:10px;color:#aaa;">excl. ${noPrior.join(', ')}</div>` : ''}</td>
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

// "Emerald Views 1.32 (18 nts) · …" for the forecast footnote
function ratioNote(ratios) {
  if (!ratios) return 'not available';
  return PROPERTIES.map(p => {
    const r = ratios[p.id];
    if (!r?.ratio) return `${p.name} —`;
    if (r.source === 'few_nights') return `${p.name} ${r.ratio.toFixed(2)} (portfolio ratio; only ${r.nights} booked nights)`;
    if (r.source === 'out_of_range') return `${p.name} ${r.ratio.toFixed(2)} (portfolio ratio; own ratio ${r.own.toFixed(2)} is outside ${FORECAST_RATIO_RANGE.join('–')})`;
    return `${p.name} ${r.ratio.toFixed(2)} (${r.nights} nts)`;
  }).join(' · ');
}

function sectionRevenueForecast(paceMonths, todayStr, tyBookings, tyBlocked, histActive, histBlocked, plData, ratios) {
  let html = `<h2 id="section-forecast" style="${H2}">🔮 Revenue Forecast</h2>`;
  html += `<p style="font-size:12px;color:#888;margin:0 0 16px;">Projected month-end revenue: confirmed bookings + expected fill of remaining open nights based on historical patterns.</p>`;

  for (const month of paceMonths) {
    const forecasts = PROPERTIES.map(prop =>
      computePropertyForecast(prop, month, todayStr, tyBookings, tyBlocked, histActive, histBlocked, plData, ratios?.[prop.id])
    );

    let totConfirmed = 0, totConservative = 0, totBase = 0, totOptimistic = 0, totLY = 0;
    const excludedFromScenarios = [];
    const noPriorYear = [];

    let rows = '';
    forecasts.forEach((f, i) => {
      rows += groupRow(f.prop, i, 8);
      totConfirmed += f.confirmedRevenue;
      if (f.lyActualRevenue == null) noPriorYear.push(f.prop.name);
      else totLY += f.lyActualRevenue;

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
        const exp  = Math.round(f.expectedNights * 10) / 10;
        const past = f.pastRange ? (f.pastRange[0] === f.pastRange[1] ? `${f.pastRange[0]}` : `${f.pastRange[0]}–${f.pastRange[1]}`) : '—';
        fillRateCell = `<td style="padding:7px 10px;text-align:right;">${pct}%
          <div style="font-size:10px;color:#aaa;">n=${yrs} yr${yrs !== 1 ? 's' : ''}</div>
          <div style="font-size:10px;color:#666;white-space:nowrap;">exp. ${exp} nts · past ${past}</div></td>`;
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
        : `<td style="padding:7px 10px;text-align:right;">${f.openNights}${f.avgPrice ? `<div style="font-size:10px;color:#aaa;">avg ${fmt$(Math.round(f.avgPrice))}/nt</div>` : ''}${f.priceCapped
            ? `<div style="font-size:10px;color:#aaa;white-space:nowrap;">late-booked avg; PL ${fmt$(Math.round(f.plValue))}</div>` : ''}</td>`;

      const lyColor = f.isRedFlag ? '#c0392b' : '#666';
      rows += `<tr style="background:${rowBg};border-bottom:1px solid #f0f0f0;">
        <td style="padding:7px 10px;">${badge(f.prop.name, f.prop.color)}</td>
        <td style="padding:7px 10px;text-align:right;font-weight:600;">${fmt$(Math.round(f.confirmedRevenue))}
          <div style="font-size:10px;color:#aaa;font-weight:400;">${f.confirmedNights} nts</div></td>
        ${openNtsCell}
        ${fillRateCell}
        ${scenarioCells}
        <td style="padding:7px 10px;text-align:right;color:${lyColor};">${f.lyActualRevenue == null ? '<span style="font-size:11px;color:#aaa;">No prior year</span>' : fmt$(Math.round(f.lyActualRevenue))}</td>
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
      <td style="padding:7px 12px;text-align:right;font-weight:700;color:#666;">${fmt$(Math.round(totLY))}${noPriorYear.length ? `<div style="font-size:10px;color:#aaa;font-weight:400;">excl. ${noPriorYear.join(', ')}</div>` : ''}</td>
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
    All amounts are gross (cleaning and taxes included), prorated for bookings spanning month boundaries.
    Open nights are valued at the lower of (a) the PriceLabs price × each property's booked-gross ratio (booked gross ÷ PriceLabs price on its booked nights in the next 90 days: ${ratioNote(ratios)}) and (b) the average gross per night that nights booked after this calendar date earned in the same month over the last ${LATE_ADR_YEARS} years with such bookings (fewer if that's all the history). "late-booked avg" marks where (b) is used, with (a) shown as PL.
    Fill rate = % of open nights at this same calendar date historically that were booked by month-end, averaged across all available prior years. exp. = open nights × fill rate (base); past = nights filled after this date in those years (lowest–highest).
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

// Historical ADR for an event's dates and the current PriceLabs average over them
function eventPricing(ev, prop, plData, histActive, cutoff90) {
  const hist = histActive ? computeEventADR(ev, histActive, prop.id) : null;
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
  return { hist, currentAvgPrice };
}

// Events in the next 90 days as the Events table lists them: deduped by id,
// Ticketmaster events only at high/very-high impact
function upcomingEvents90(hardcodedEvents, cachedEvents, todayStr) {
  const cutoff90 = addDays(todayStr, 90);
  const byId = new Map();
  for (const ev of [...hardcodedEvents, ...cachedEvents]) if (!byId.has(ev.id)) byId.set(ev.id, ev);
  return [...byId.values()].filter(ev =>
    ev.end_date >= todayStr && ev.start_date <= cutoff90
    && !(ev.source === 'ticketmaster' && ev.impact !== 'high' && ev.impact !== 'very-high'));
}

// "Potentially underpriced" in the Events table: not a slow-season watch period,
// and the PriceLabs average is more than 10% below historical ADR
function eventUnderpricedPct(ev, prop, plData, histActive, todayStr) {
  if (ev.is_watch) return null;
  const { hist, currentAvgPrice } = eventPricing(ev, prop, plData, histActive, addDays(todayStr, 90));
  if (!hist || !currentAvgPrice || currentAvgPrice >= hist.adr * 0.90) return null;
  return { pct: Math.round((1 - currentAvgPrice / hist.adr) * 100), adr: hist.adr };
}

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

      const { hist, currentAvgPrice } = eventPricing(ev, prop, plData, histActive, cutoff90);

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
      } else if (currentAvgPrice && currentAvgPrice < hist.adr * 0.90) { // same test as eventUnderpricedPct
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

// Cancelled amount = gross while the stay was active (the portal records it from
// Nov 2026; earlier cancellations show "amount not recorded")
const cancelledAmount = b => b.last_active_gross != null ? `${fmt$(Number(b.last_active_gross))} cancelled` : 'amount not recorded';
function rebookedText(b, nights) {
  if (!b.rebookedNights) return 'Not rebooked yet';
  return b.rebookedNights >= nights
    ? `Rebooked: all ${nights} night${nights !== 1 ? 's' : ''}, ${fmt$(b.rebookedGross)}`
    : `Rebooked: ${b.rebookedNights} of ${nights} nights, ${fmt$(b.rebookedGross)}`;
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
        <strong style="color:#c0392b;">${cancelledAmount(b)}</strong>
        <div style="font-size:12px;color:#888;margin-top:2px;">${rebookedText(b, n)}</div>
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

function buildPropertySummaries(plData, alertData, bookings, lastBookedMap, activity, mtd, tyBookings, lyBookings, paceMonths, hardcodedEvents, cachedEvents, histActive, todayStr) {
  const now = new Date();
  const t14 = addDays(todayStr, 14);

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
    // Priority (1 = first): 1 failures · 2 cancellations · 3 1-night gaps (14 days)
    // · 4 RED pricing · 5 YELLOW pricing · 6 no recent bookings · 7 pace · 8 underpriced events
    const actions = [];

    // Cancellations for this property in last 24h (fully rebooked ones stay in Activity only)
    for (const c of (activity.cancellations || [])) {
      if (c.property_id !== prop.id) continue;
      const nights = c.nights || Math.max(1, diffDays(c.arrival_date, c.departure_date));
      if (c.rebookedNights >= nights) continue;
      actions.push({
        level: 'red', priority: 2, anchor: '#section-activity', sectionLabel: 'Activity',
        text: `${c.guest_display_name || 'Guest'} cancelled ${fmtDate(c.arrival_date)}–${fmtDate(c.departure_date)} (${nights} night${nights !== 1 ? 's' : ''}, ${cancelledAmount(c)}). ${rebookedText(c, nights)}.`,
      });
    }

    // Pricing alerts with full "because" explanation
    // A property PriceLabs couldn't check is flagged (a failure), never shown as on track
    const propAlerts = prop.plId && plData && alertData
      ? computePropertyAlerts(prop, plData, alertData, bookings, todayStr)
      : null;
    if (prop.plId && propAlerts === null) {
      actions.push({
        level: 'yellow', priority: 1, anchor: '#section-pricing', sectionLabel: 'Pricing Alerts',
        text: 'Pricing couldn\'t be checked today — PriceLabs data is missing (see the alert at the top).',
      });
    }
    if (propAlerts) {
      for (const a of propAlerts) {
        if (a.level === 'OK') continue;
        actions.push({
          level: a.level === 'RED' ? 'red' : 'yellow',
          priority: a.level === 'RED' ? 4 : 5,
          anchor: '#section-pricing', sectionLabel: 'Pricing Alerts',
          text: `${a.window}: ${alertBecause(a)}`,
        });
      }
    }

    // Events stay in the Events section; only ones flagged underpriced there come
    // onto the board (no jump link: anchors don't work reliably in email)
    // One item per property: an entry per night (or date span), events on the same
    // night combined, soonest first. Items rank among themselves by soonest night.
    const underByNight = new Map(); // "start|end" → { start, end, names, pct }
    for (const ev of upcomingEvents90(hardcodedEvents, cachedEvents, todayStr)) {
      if (ev.market !== prop.market) continue;
      const under = eventUnderpricedPct(ev, prop, plData, histActive, todayStr);
      if (!under) continue;
      const key = `${ev.start_date}|${ev.end_date}`;
      const e = underByNight.get(key) ?? { start: ev.start_date, end: ev.end_date, names: [], pct: 0 };
      if (!e.names.includes(ev.name)) e.names.push(ev.name);
      e.pct = Math.max(e.pct, under.pct);
      underByNight.set(key, e);
    }
    if (underByNight.size) {
      const nightOf = e => (e.start < todayStr ? todayStr : e.start);
      const entries = [...underByNight.values()].sort((a, b) => nightOf(a).localeCompare(nightOf(b)) || a.end.localeCompare(b.end));
      const list = entries.map(e => {
        const dStr = e.end === e.start ? fmtDate(e.start) : `${fmtDate(e.start)}–${fmtDate(e.end)}`;
        return `${dStr} ${e.names.join(', ')} (−${e.pct}%)`;
      }).join('; ');
      actions.push({
        level: 'event', priority: 8, sortKey: nightOf(entries[0]), anchor: null,
        text: `Event nights priced below their historical ADR: ${list}. Consider raising prices in PriceLabs; see Events.`,
      });
    }

    // No new bookings in 14+ days with open nights
    if (plData && daysSince != null && daysSince >= 14 && openNext30 > 0) {
      actions.push({
        level: 'watch', priority: 6, anchor: '#section-pricing', sectionLabel: 'Pricing',
        text: `No new bookings in ${daysSince} days with ${openNext30} open night${openNext30 !== 1 ? 's' : ''} available in the next 30 days. Check listing rank, photos, and reviews across all channels.`,
      });
    }

    // 1-night gaps in next 14 days — soonest one + count
    const nearGaps = gapNights(bookings, prop.id, todayStr, t14);
    if (nearGaps.length > 0) {
      const top    = nearGaps[0];
      const offers = top.sides.map(s => `${s.guest} (${s.channel}${s.offer != null ? `, offer ${fmt$(s.offer)}` : ''})`).join(' or ');
      const more   = nearGaps.length > 1 ? ` (+${nearGaps.length - 1} more in the next 14 days)` : '';
      actions.push({
        level: 'gap', priority: 3, anchor: '#section-gaps', sectionLabel: 'Open Nights',
        text: `1-night gap ${fmtDateL(top.date)} — offer it to ${offers}.${more}`,
      });
    }

    // Booking pace >20% behind LY for first pace month (LY measured against LY's month)
    const pm = paceMonths[0];
    let tyRev = 0, lyRev = 0;
    for (const b of tyBookings) { if (b.property_id === prop.id) tyRev += prorateToMonth(b, pm.start, pm.end).revenue; }
    for (const b of lyBookings) { if (b.property_id === prop.id) lyRev += prorateToMonth(b, pm.lyStart, pm.lyEnd).revenue; }
    if (hasPriorYear(prop, pm.lyStart) && lyRev > 200 && tyRev < lyRev * 0.80) {
      const pct = Math.round((1 - tyRev / lyRev) * 100);
      actions.push({
        level: 'watch', priority: 7, anchor: '#section-pace', sectionLabel: 'Booking Pace',
        text: `${pm.label} bookings are ${pct}% behind last year (${fmt$(Math.round(tyRev))} vs ${fmt$(Math.round(lyRev))}). Consider a promotion or price adjustment to stimulate demand.`,
      });
    }

    // ── Status ───────────────────────────────────────────────────────────────
    const hasRed   = actions.some(a => a.level === 'red');
    const hasWatch = actions.some(a => ['yellow', 'watch', 'gap', 'event'].includes(a.level));
    summaries.push({ prop, synopsis, actions, status: hasRed ? 'red' : hasWatch ? 'yellow' : 'green' });
  }

  // ── Portfolio note (MTD): earned nights vs the same nights last year,
  // properties with a prior year only (same figures as the MTD table)
  let curRevTotal = 0, lyRevTotal = 0;
  if (mtd) {
    const fig = mtdFigures(mtd);
    for (const p of PROPERTIES) if (fig[p.id].lySame) { curRevTotal += fig[p.id].earned.gross; lyRevTotal += fig[p.id].lySame.gross; }
  }
  let portfolioNote = null;
  if (lyRevTotal > 200 && curRevTotal < lyRevTotal * 0.85) {
    const pct = Math.round((1 - curRevTotal / lyRevTotal) * 100);
    portfolioNote = `Portfolio MTD earned: ${fmt$(Math.round(curRevTotal))} vs ${fmt$(Math.round(lyRevTotal))} on the same nights last year (${pct}% behind). See MTD Revenue section for property breakdown.`;
  }

  return { summaries, portfolioNote };
}

// The board shows the top BOARD_LIMIT items across all properties by priority
// (ties by sortKey where set, e.g. soonest event night, then property order and
// the order items were added). Card status
// still reflects every item, shown or not.
const BOARD_LIMIT = 10;

function sectionPriorityBoard({ summaries, portfolioNote }, todayStr) {
  const shown = new Set(
    summaries.flatMap(s => s.actions)
      .map((a, i) => ({ a, i }))
      .sort((x, y) => (x.a.priority ?? 9) - (y.a.priority ?? 9)
        || (x.a.sortKey ?? '').localeCompare(y.a.sortKey ?? '') || x.i - y.i)
      .slice(0, BOARD_LIMIT)
      .map(x => x.a)
  );
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
      const top  = actions.filter(a => shown.has(a)).sort((x, y) => x.priority - y.priority);
      const rest = actions.length - top.length;
      const rows = top.map((a, i) => {
        const c    = ACTION_COLOR[a.level] || '#555';
        const jump = !a.anchor ? '' : `<a href="${a.anchor}" style="font-size:11px;color:#406A94;text-decoration:none;font-weight:600;margin-left:10px;white-space:nowrap;">↓ ${a.sectionLabel}</a>`;
        const sep  = i < top.length - 1 || rest ? 'border-bottom:1px solid #f3f4f6;' : '';
        return `<div style="padding:8px 0;${sep}font-size:13px;line-height:1.5;color:${c};">→ ${boldDollars(a.text)}${jump}</div>`;
      }).join('');
      const more = rest
        ? `<div style="padding:8px 0;font-size:12px;color:#888;">${prop.name}: ${rest} more item${rest !== 1 ? 's' : ''} (see the sections below)</div>`
        : '';
      body = `<div style="padding:4px 14px 10px;">${rows}${more}</div>`;
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

  // First full month per property: last-year comparisons start there
  const firstArrivals = await step('First stays', fetchFirstArrivals);
  for (const p of PROPERTIES) p.firstFullMonth = firstFullMonth(firstArrivals?.[p.id]);

  const paceMonths = getPaceMonths(todayStr);
  const cachedEvents = fetchEventsCache(todayStr);
  const [activity, mtd, bookings, taxProfiles, paceData, forecastData, lastBookedMap, pickup] = await Promise.all([
    step('Recent activity', fetchRecentActivity),
    step('Month-to-date revenue', () => fetchMTDRevenue(todayStr)),
    step('Bookings (next 90 days)', () => fetchBookings90(todayStr, t90)),
    step('Tax profiles', fetchTaxProfiles),
    step('Booking pace', () => fetchBookingPaceData(paceMonths, todayStr)),
    step('Revenue forecast history', () => fetchRevenueForecastData(paceMonths, todayStr)),
    fetchLastBookedDates(),
    step('Pickup', fetchPickupData),
  ]);
  // Open nights, gaps, prices and alerts all depend on the 90-day bookings
  if (!bookings) throw new Error('Bookings for the next 90 days could not be loaded.');
  const { tyBookings, lyBookings } = paceData ?? { tyBookings: null, lyBookings: null };
  const { tyBlocked, histActive, histBlocked } = forecastData ?? { tyBlocked: null, histActive: null, histBlocked: null };

  console.log(`  Bookings (90d): ${bookings.length} | New: ${activity?.newBookings.length ?? '—'} | Cancelled: ${activity?.cancellations.length ?? '—'} | MTD: ${mtd?.cur.length ?? '—'}`);
  console.log(`  Pace months: ${paceMonths.map(m => m.label).join(', ')} | TY: ${tyBookings?.length ?? '—'} bkgs | LY: ${lyBookings?.length ?? '—'} bkgs as they stood (${paceData?.lyAmountsMissing ?? '—'} cancelled later, amount not recorded)`);
  console.log(`  Pickup (15d): TY ${pickup?.ty.length ?? '—'} | LY ${pickup?.ly.length ?? '—'} · first full months: ${PROPERTIES.map(p => `${p.name} ${p.firstFullMonth ?? '—'}`).join(', ')}`);
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

  // Market 7-day pickup from neighborhood data, by the property's bedroom category
  const marketPickup = {};
  for (const p of plProps()) {
    const a = alertData?.[p.plId];
    if (a?.market) marketPickup[p.id] = parseMarketPickup(a.market, a.settings?.no_of_bedrooms ?? 1, p.name, todayStr);
  }

  // Forecast basis: booked gross ÷ PriceLabs price per property
  const forecastRatios = plData ? bookedPriceRatios(bookings, plData, todayStr) : null;
  if (forecastRatios) console.log(`  Forecast ratios: ${ratioNote(forecastRatios)}`);

  // Priority Action Board: per-property summary with action items
  console.log('  Building Priority Action Board...');
  const { summaries, portfolioNote } = buildPropertySummaries(
    plData, alertData, bookings, lastBookedMap,
    activity ?? { newBookings: [], cancellations: [] }, mtd,
    tyBookings ?? [], lyBookings ?? [], paceMonths, hardcodedEvents, cachedEvents, histActive, todayStr);
  const priorityBoardHtml = sectionPriorityBoard({ summaries, portfolioNote }, todayStr);
  const totalActions = summaries.reduce((n, s) => n + s.actions.length, 0);
  console.log(`  ✓ Priority Action Board: ${totalActions} action items across ${summaries.length} properties`);

  const sections = [
    mtd       ? sectionMTD(mtd, todayStr) : sectionUnavailable('section-mtd', '📊 Month-to-Date Revenue'),
    activity  ? sectionActivity(activity) : sectionUnavailable('section-activity', '🔔 Activity — Last 24 Hours'),
    sectionPricingAlerts(plData, alertData, bookings, todayStr),
    sectionSmartEvents(hardcodedEvents, cachedEvents, plData, histActive ?? [], todayStr),
    sectionOpenNights(bookings, todayStr, taxProfiles, plData),
    paceData  ? sectionBookingPace(paceData, paceMonths, todayStr, pickup, lastBookedMap, marketPickup) : sectionUnavailable('section-pace', '📈 Booking Pace vs Last Year'),
    paceData && forecastData
      ? sectionRevenueForecast(paceMonths, todayStr, tyBookings, tyBlocked, histActive, histBlocked, plData, forecastRatios)
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
