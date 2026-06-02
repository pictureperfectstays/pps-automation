#!/usr/bin/env node
// scan-events.js — Weekly event discovery scanner
// Run: node scan-events.js
// Schedule: Mon/Thu 5am AZ (12:00 UTC) via GitHub Actions
// Required env: SUPABASE_URL, SUPABASE_SERVICE_KEY, RESEND_API_KEY, TICKETMASTER_API_KEY

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { MARKETS, MARKET_COORDS } from './events-calendar.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Credentials ─────────────────────────────────────────────────────────────

function loadEnv() {
  const env = { ...process.env };
  // Always merge both global and local settings so all keys are available locally
  for (const p of [join(homedir(), '.claude', 'settings.json'), join(__dirname, 'settings.json')]) {
    try { const s = JSON.parse(readFileSync(p, 'utf8')); if (s.env) Object.assign(env, s.env); } catch {}
  }
  return env;
}

const ENV = loadEnv();
const SUPABASE_URL  = ENV.SUPABASE_URL;
const SUPABASE_KEY  = ENV.SUPABASE_SERVICE_KEY;
const RESEND_KEY    = ENV.RESEND_API_KEY;
const TM_KEY        = ENV.TICKETMASTER_API_KEY;
const TAVILY_KEY    = ENV.TAVILY_API_KEY;
const ANTHROPIC_KEY = ENV.ANTHROPIC_API_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) { console.error('Missing Supabase credentials'); process.exit(1); }
if (!RESEND_KEY)    { console.error('Missing RESEND_API_KEY'); process.exit(1); }
if (!TM_KEY)        { console.warn('Warning: TICKETMASTER_API_KEY not set — skipping Ticketmaster scan'); }
if (!TAVILY_KEY)    { console.warn('Warning: TAVILY_API_KEY not set — skipping web search'); }
if (!ANTHROPIC_KEY) { console.warn('Warning: ANTHROPIC_API_KEY not set — skipping web search parsing'); }

const SEND_TO   = 'chris@staypictureperfect.com';
const SEND_FROM = 'reports@mail.staypictureperfect.com';

// ESPN team IDs → { sport path, teamId, market, homeLabel }
const ESPN_TEAMS = [
  { sport: 'football/nfl',                       teamId: '22',   market: MARKETS.SCOTTSDALE, name: 'Arizona Cardinals' },
  { sport: 'football/college-football',           teamId: '9',    market: MARKETS.SCOTTSDALE, name: 'ASU Sun Devils Football' },
  { sport: 'football/college-football',           teamId: '2633', market: MARKETS.SEVIERVILLE, name: 'Tennessee Volunteers Football' },
  { sport: 'basketball/mens-college-basketball',  teamId: '2633', market: MARKETS.SEVIERVILLE, name: 'Tennessee Volunteers Basketball' },
];

const CACHE_PATH = join(__dirname, 'events-cache.json');

// ─── Date helpers ─────────────────────────────────────────────────────────────

const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const fmtDate = d => { const [,m,day] = d.split('-'); return `${MONTHS[+m-1]} ${+day}`; };

// ─── Local File Cache ─────────────────────────────────────────────────────────
// Stored at daily-report/events-cache.json, committed to repo by GitHub Actions.

function readCache() {
  try {
    if (!existsSync(CACHE_PATH)) return { last_updated: null, events: [] };
    return JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
  } catch {
    return { last_updated: null, events: [] };
  }
}

function writeCache(data) {
  writeFileSync(CACHE_PATH, JSON.stringify(data, null, 2), 'utf8');
}

// ─── Ticketmaster ─────────────────────────────────────────────────────────────

// Arena-class venues — events here are HIGH impact regardless of reported capacity
const ARENA_VENUE_KEYWORDS = {
  [MARKETS.SCOTTSDALE]: [
    'footprint center', 'state farm stadium', 'chase field', 'ak-chin', 'acrisure amphitheatre',
    'talking stick resort arena', 'desert diamond arena', 'gila river arena',
    'salt river fields', 'westworld of scottsdale',
  ],
  [MARKETS.SEVIERVILLE]: [
    'neyland stadium', 'thompson-boling arena', 'bridgestone arena',
  ],
  [MARKETS.PCB]: [
    'frank brown park amphitheater',
  ],
};

// All trackable venue keywords — events at these venues pass the size filter
const MAJOR_VENUE_KEYWORDS = {
  [MARKETS.SCOTTSDALE]: [
    ...( ARENA_VENUE_KEYWORDS[MARKETS.SCOTTSDALE]),
    'arizona financial theatre', 'talking stick resort amp', 'mullett arena',
    'marquee theatre', 'van buren', 'westworld',
  ],
  [MARKETS.SEVIERVILLE]: [
    ...(ARENA_VENUE_KEYWORDS[MARKETS.SEVIERVILLE]),
    'leconte center', 'smokies stadium', 'sevierville convention',
  ],
  [MARKETS.PCB]: [
    ...(ARENA_VENUE_KEYWORDS[MARKETS.PCB]),
    'frank brown park', 'pier park', 'grand lagoon amphitheater', 'panama city amphitheater',
  ],
};

// Classify a Ticketmaster event. Returns null to skip, or { impact, category } to keep.
function classifyTmEvent(ev, market) {
  const cls   = ev.classifications?.[0] || {};
  const seg   = (cls.segment?.name   || '').toLowerCase();
  const genre = (cls.genre?.name     || '').toLowerCase();
  const sub   = (cls.subGenre?.name  || '').toLowerCase();
  const name  = (ev.name             || '').toLowerCase();
  const venue = ev._embedded?.venues?.[0] || {};
  const vName = (venue.name          || '').toLowerCase();
  const vCap  = venue.capacity       || 0;
  const month = parseInt((ev.dates?.start?.localDate || '0000-00').slice(5, 7));
  const category = [cls.segment?.name, cls.genre?.name].filter(Boolean).join(' — ') || 'Event';

  // ── Hard skips ──────────────────────────────────────────────────────────
  if (!seg || seg === 'miscellaneous' || seg === 'undefined') return null;
  if (/stadium tour|behind.the.scenes|ballpark tour|field trip/i.test(name)) return null;

  if (seg === 'sports') {
    // Football is handled by ESPN (Cardinals, ASU). Skip from TM to avoid duplicates.
    if (genre === 'football') return null;

    // MLB regular season (April–September) — 81 games/season, minimal individual impact
    if (genre === 'baseball' && month >= 4 && month <= 9) return null;

    // NHL — no team in any of our markets
    if (genre === 'ice hockey') return null;

    // NBA regular season — too many games, low individual impact.
    // Keep only if event name suggests playoffs/finals.
    if (genre === 'basketball' && sub === 'nba basketball') {
      const isPostseason = /playoff|first round|second round|conference|semifinal|final|championship/i.test(name);
      if (!isPostseason) return null;
    }

    // College basketball handled by ESPN — skip from TM
    if (genre === 'basketball' && sub !== 'nba basketball') return null;

    // ── Sports impact scoring ──────────────────────────────────────────────
    let impact = 'moderate';
    if (genre === 'motor sports' || sub.includes('nascar') || sub.includes('indycar')) impact = 'high';
    else if (genre === 'golf') impact = 'very-high';
    else if (genre === 'boxing' || genre === 'mixed martial arts') impact = 'high';
    else if (genre === 'baseball' && month >= 10) impact = 'high'; // MLB postseason
    else if (genre === 'basketball') impact = 'high';              // NBA playoffs (passed above)
    else if (genre === 'soccer' || genre === 'football (soccer)') impact = 'moderate';
    return { impact, category };
  }

  if (seg === 'music' || seg === 'arts & theatre') {
    // Require major venue OR minimum capacity for concerts/theater
    const isMajorVenue = (MAJOR_VENUE_KEYWORDS[market] || []).some(k => vName.includes(k));
    if (!isMajorVenue && vCap < 5000) return null;

    // ── Music/arts impact scoring ──────────────────────────────────────────
    const isArena = (ARENA_VENUE_KEYWORDS[market] || []).some(k => vName.includes(k));
    let impact = 'moderate';
    if (isArena || vCap >= 15000 || /festival/i.test(name)) impact = 'high';
    else if (vCap >= 5000 || isMajorVenue) impact = 'moderate';

    // Conventions / expos at large venues
    if (/convention|expo|comic.?con|fan fest/i.test(name)) impact = 'moderate';
    return { impact, category };
  }

  return null; // Skip anything else
}

async function fetchTicketmaster(market, fromDate, toDate) {
  if (!TM_KEY) return [];
  const coords = MARKET_COORDS[market];
  const events = [];
  let page = 0;
  let fetched = 0, skipped = 0;

  while (true) {
    const params = new URLSearchParams({
      apikey: TM_KEY,
      latlong: `${coords.lat},${coords.lng}`,
      radius: String(coords.radius),
      unit: 'miles',
      startDateTime: `${fromDate}T00:00:00Z`,
      endDateTime: `${toDate}T23:59:59Z`,
      size: '200',
      page: String(page),
      sort: 'date,asc',
    });
    const url = `https://app.ticketmaster.com/discovery/v2/events.json?${params}`;
    let data;
    try {
      const r = await fetch(url);
      if (!r.ok) { console.warn(`  TM ${market} page ${page}: ${r.status}`); break; }
      data = await r.json();
    } catch (e) { console.warn(`  TM fetch error: ${e.message}`); break; }

    const items = data?._embedded?.events || [];
    fetched += items.length;
    for (const ev of items) {
      const dateInfo = ev.dates?.start;
      if (!dateInfo?.localDate) { skipped++; continue; }
      const classification = classifyTmEvent(ev, market);
      if (!classification) { skipped++; continue; }

      const start = dateInfo.localDate;
      const end   = ev.dates?.end?.localDate || start;
      events.push({
        id:           `tm-${ev.id}`,
        name:         ev.name,
        market,
        start_date:   start,
        end_date:     end,
        impact:       classification.impact,
        is_watch:     false,
        source:       'ticketmaster',
        source_id:    ev.id,
        category:     classification.category,
        venue:        ev._embedded?.venues?.[0]?.name || '',
        venue_capacity: ev._embedded?.venues?.[0]?.capacity || null,
        url:          ev.url || '',
        notes:        '',
        discovered_at: new Date().toISOString(),
      });
    }

    const totalPages = data?.page?.totalPages ?? 1;
    if (page >= totalPages - 1 || items.length === 0) break;
    page++;
    await new Promise(r => setTimeout(r, 250));
  }

  console.log(`    ${market}: ${events.length} kept / ${skipped} skipped of ${fetched} fetched`);
  return events;
}

// ─── ESPN Sports Schedules ────────────────────────────────────────────────────

async function fetchEspnSchedule(team, seasons) {
  const games = [];
  for (const season of seasons) {
    const url = `https://site.api.espn.com/apis/site/v2/sports/${team.sport}/teams/${team.teamId}/schedule?season=${season}`;
    let data;
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      data = await r.json();
    } catch { continue; }

    const events = data?.events || [];
    for (const ev of events) {
      const comp = ev.competitions?.[0];
      if (!comp) continue;

      // Find if this team is the home team
      const homeCompetitor = comp.competitors?.find(c => c.homeAway === 'home');
      if (!homeCompetitor) continue;
      const isHome = homeCompetitor.team?.id === team.teamId ||
                     homeCompetitor.team?.abbreviation != null; // fallback: first result is always the queried team's perspective

      // For college teams the API always returns from the team's perspective — check venue city
      // For NFL we can check competitor team ID directly
      const teamIsHome = comp.competitors?.find(
        c => c.homeAway === 'home' && (c.team?.id === team.teamId || c.team?.links?.some(l => l.href?.includes(`/teams/${team.teamId}`)))
      );

      // Simpler heuristic: if venue is in the team's home city, it's a home game
      const venue = comp.venue;
      const venueName = venue?.fullName || '';
      const venueCity = venue?.address?.city || '';

      // Home city keywords per team
      const homeCities = {
        '22':   ['glendale', 'arizona', 'state farm'],
        '9':    ['tempe', 'mountain america', 'arizona state'],
        '2633': ['knoxville', 'neyland', 'thompson'],
      };
      const keywords = homeCities[team.teamId] || [];
      const combined = (venueName + ' ' + venueCity).toLowerCase();
      const isHomeGame = keywords.some(k => combined.includes(k));
      if (!isHomeGame) continue;

      const dateStr = ev.date?.slice(0, 10);
      if (!dateStr) continue;

      // Find opponent name
      const opponent = comp.competitors?.find(c => c.homeAway === 'away')?.team?.displayName || 'TBD';
      const gameId = `espn-${team.sport.replace(/\//g, '-')}-${ev.id}`;

      games.push({
        id: gameId,
        name: `${team.name} vs ${opponent}`,
        market: team.market,
        start_date: dateStr,
        end_date: dateStr,
        impact: 'high',
        is_watch: false,
        source: 'espn',
        source_id: ev.id,
        category: team.sport.includes('basketball') ? 'Sports — Basketball' : 'Sports — Football',
        venue: venueName || venueCity,
        notes: `Home game at ${venueName || venueCity}${venueCity ? ', ' + venueCity : ''}`,
        discovered_at: new Date().toISOString(),
      });
    }
  }
  return games;
}

async function fetchAllSportsEvents() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1; // 1-indexed
  // Fetch current and upcoming seasons — sports seasons span calendar years
  const seasons = month >= 7 ? [year, year + 1] : [year - 1, year];

  const results = [];
  for (const team of ESPN_TEAMS) {
    console.log(`  ESPN: fetching ${team.name}...`);
    try {
      const games = await fetchEspnSchedule(team, seasons);
      console.log(`    → ${games.length} home games found`);
      results.push(...games);
    } catch (e) {
      console.warn(`    ESPN fetch failed for ${team.name}: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 200));
  }
  return results;
}

// ─── Tavily Web Search ────────────────────────────────────────────────────────

// Targeted queries per market — {year} is replaced with actual year at runtime
const MARKET_SEARCHES = {
  [MARKETS.PCB]: [
    'Panama City Beach Florida major events festivals {year} dates',
    'Panama City Beach FL annual events schedule {year}',
  ],
  [MARKETS.SCOTTSDALE]: [
    'Scottsdale Arizona major events festivals conventions {year} dates',
    'Scottsdale Tempe Mesa large events schedule {year}',
  ],
  [MARKETS.SEVIERVILLE]: [
    'Pigeon Forge Gatlinburg Sevierville Tennessee major events {year} dates',
    'Smoky Mountains large festivals events schedule {year}',
  ],
};

async function tavilySearch(query) {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: TAVILY_KEY, query, max_results: 5, search_depth: 'basic' }),
  });
  if (!res.ok) { console.warn(`    Tavily ${res.status}: ${query}`); return []; }
  const data = await res.json();
  return data.results || [];
}

async function parseEventsWithClaude(market, results, year) {
  const content = results.map(r => `URL: ${r.url}\nTitle: ${r.title}\nContent: ${r.content}`).join('\n\n---\n\n');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      system: `Extract events from web search results for short-term rental pricing decisions in ${market}.
Return ONLY a valid JSON array — no other text. Include events that:
- Drive significant rental demand (festivals, large concerts, major sports, conventions, car shows, air shows, etc.)
- Have specific dates in ${year} or ${year + 1}
- Expected attendance 5,000+ or known to fill local hotels

Each item: { "name": string, "start_date": "YYYY-MM-DD", "end_date": "YYYY-MM-DD", "impact": "high"|"very-high", "notes": string }
impact "very-high" = 50k+ attendance or fills the entire market.
impact "high" = 5k–50k or strong local hotel demand.
Skip events with no specific dates. Return [] if nothing qualifies.`,
      messages: [{ role: 'user', content: `Find events in ${market}:\n\n${content}` }],
    }),
  });
  if (!res.ok) { const err = await res.text(); console.warn(`    Claude parse failed: ${res.status} — ${err.slice(0, 120)}`); return []; }
  const data = await res.json();
  const text = data.content?.[0]?.text?.trim() || '[]';
  try { return JSON.parse(text); } catch { console.warn('    Could not parse Claude JSON response'); return []; }
}

function isValidIsoDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T00:00:00Z'));
}

async function webSearchEvents(year) {
  if (!TAVILY_KEY || !ANTHROPIC_KEY) return [];

  const allFound = [];

  for (const [market, queryTemplates] of Object.entries(MARKET_SEARCHES)) {
    console.log(`  Web search: ${market}...`);
    const allResults = [];

    for (const template of queryTemplates) {
      for (const y of [year, year + 1]) {
        const query = template.replace(/\{year\}/g, String(y));
        const results = await tavilySearch(query);
        allResults.push(...results);
        await new Promise(r => setTimeout(r, 300));
      }
    }

    // Deduplicate search results by URL before sending to Claude
    const unique = [...new Map(allResults.map(r => [r.url, r])).values()].slice(0, 10);
    console.log(`    ${unique.length} unique results — parsing with Claude Haiku...`);

    const parsed = await parseEventsWithClaude(market, unique, year);
    console.log(`    → ${parsed.length} events extracted`);

    for (const ev of parsed) {
      if (!ev.name || !isValidIsoDate(ev.start_date) || !isValidIsoDate(ev.end_date)) continue;
      const slug = ev.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
      allFound.push({
        id:           `web-${slug}-${ev.start_date}`,
        name:         ev.name,
        market,
        start_date:   ev.start_date,
        end_date:     ev.end_date,
        impact:       ['high', 'very-high'].includes(ev.impact) ? ev.impact : 'high',
        is_watch:     false,
        source:       'web-search',
        notes:        ev.notes || '',
        discovered_at: new Date().toISOString(),
      });
    }
  }

  return allFound;
}

// ─── Merge & Dedup ────────────────────────────────────────────────────────────

function mergeEvents(existing, fresh) {
  // Primary dedup: by source_id (TM event ID or ESPN game ID)
  const existingById = new Map();
  for (const ev of existing) {
    const key = ev.source_id || ev.id;
    existingById.set(key, ev);
  }

  // Secondary dedup: by (normalized name + market + start_date) catches same show with multiple TM listings
  const existingByNameDate = new Set(
    existing.map(ev => `${ev.name.toLowerCase().trim()}|${ev.market}|${ev.start_date}`)
  );

  const newEvents = [];
  const allEvents = [...existing];

  for (const ev of fresh) {
    const idKey       = ev.source_id || ev.id;
    const nameKey     = `${ev.name.toLowerCase().trim()}|${ev.market}|${ev.start_date}`;
    if (!existingById.has(idKey) && !existingByNameDate.has(nameKey)) {
      ev.discovered_at = ev.discovered_at || new Date().toISOString();
      allEvents.push(ev);
      newEvents.push(ev);
      existingByNameDate.add(nameKey); // prevent same-run duplicates too
    }
  }

  return { allEvents, newEvents };
}

// ─── Alert Email ──────────────────────────────────────────────────────────────

const PROP_NAMES = {
  [MARKETS.SCOTTSDALE]:  ['Musical Oasis', 'Travelers Paradise'],
  [MARKETS.SEVIERVILLE]: ['Enchanted Getaway'],
  [MARKETS.PCB]:         ['Emerald Views'],
};

const IMPACT_LABEL = {
  'very-high': '🔴 Very High Impact',
  'high':      '🟠 High Impact',
  'moderate':  '🟡 Moderate Impact',
  'low-moderate': '⚪ Low-Moderate Impact',
  'watch':     '⚠️ Watch Period',
};

async function sendAlertEmail(newEvents) {
  if (!newEvents.length) return;

  // Group by market
  const byMarket = {};
  for (const ev of newEvents) {
    (byMarket[ev.market] ||= []).push(ev);
  }

  const propLines = newEvents.map(ev => {
    const props = PROP_NAMES[ev.market]?.join(' & ') || ev.market;
    return `${props} (${ev.market})`;
  });
  const uniqueProps = [...new Set(propLines)];

  const subject = newEvents.length === 1
    ? `🚨 New Event Detected Near ${PROP_NAMES[newEvents[0].market]?.[0] || newEvents[0].market}: ${newEvents[0].name}`
    : `🚨 ${newEvents.length} New Events Detected — Pricing Review Needed`;

  let rows = '';
  for (const ev of newEvents) {
    const props = PROP_NAMES[ev.market]?.join(' & ') || ev.market;
    const dateRange = ev.start_date === ev.end_date
      ? fmtDate(ev.start_date)
      : `${fmtDate(ev.start_date)} – ${fmtDate(ev.end_date)}`;
    const impactLabel = IMPACT_LABEL[ev.impact] || ev.impact;
    rows += `
      <tr style="border-bottom:1px solid #f0f0f0;">
        <td style="padding:10px 14px;">
          <strong style="font-size:14px;">${ev.name}</strong><br>
          <span style="font-size:12px;color:#666;">${ev.category || ''} ${ev.venue ? '· ' + ev.venue : ''}</span>
        </td>
        <td style="padding:10px 14px;font-size:13px;color:#555;">${props}</td>
        <td style="padding:10px 14px;font-size:13px;">${dateRange}</td>
        <td style="padding:10px 14px;font-size:12px;">${impactLabel}</td>
      </tr>`;
  }

  const propCallout = uniqueProps.map(p =>
    `<li style="margin:4px 0;font-size:14px;"><strong>${p}</strong> — check current pricing against market percentiles and adjust if needed</li>`
  ).join('');

  const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#222;margin:0;padding:0;background:#f4f5f7;">
<div style="max-width:680px;margin:0 auto;padding:20px 16px;">
  <div style="background:#fff;border-radius:10px;border:1px solid #e2e8f0;border-top:4px solid #c0392b;padding:24px 28px;margin-bottom:16px;">
    <h1 style="font-size:20px;margin:0 0 6px;color:#1a1a2e;">🚨 New Event${newEvents.length > 1 ? 's' : ''} Detected</h1>
    <p style="font-size:13px;color:#64748b;margin:0;">Your weekly event scan just found ${newEvents.length} new event${newEvents.length > 1 ? 's' : ''} that may impact your pricing.</p>
  </div>

  <div style="background:#fff;border-radius:8px;border:1px solid #e8e8e8;padding:20px 24px;margin-bottom:16px;">
    <h2 style="font-size:15px;font-weight:700;color:#1a1a2e;margin:0 0 14px;padding-bottom:10px;border-bottom:2px solid #f0f0f0;">Newly Discovered Events</h2>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <tr style="background:#f8f9fa;">
        <th style="padding:8px 14px;text-align:left;font-weight:600;color:#555;">Event</th>
        <th style="padding:8px 14px;text-align:left;font-weight:600;color:#555;">Property</th>
        <th style="padding:8px 14px;text-align:left;font-weight:600;color:#555;">Dates</th>
        <th style="padding:8px 14px;text-align:left;font-weight:600;color:#555;">Impact</th>
      </tr>
      ${rows}
    </table>
  </div>

  <div style="background:#fff8e1;border-radius:8px;border:1px solid #f39c12;padding:18px 24px;margin-bottom:16px;">
    <h2 style="font-size:14px;font-weight:700;color:#e67e22;margin:0 0 10px;">⚡ Recommended Actions</h2>
    <ul style="margin:0;padding-left:20px;">
      ${propCallout}
    </ul>
    <p style="font-size:12px;color:#888;margin:12px 0 0;">
      Compare your current PriceLabs prices for these dates against your historical ADR.
      Guests hunting for deals watch for properties that haven't repriced yet after an announcement.
      Act fast — the window is usually 24–48 hours.
    </p>
  </div>

  <div style="font-size:11px;color:#bbb;text-align:center;padding:8px;">
    Picture Perfect Stays · Event Scan Alert · <a href="mailto:chris@staypictureperfect.com" style="color:#bbb;">chris@staypictureperfect.com</a>
  </div>
</div></body></html>`;

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
  const scanEnd  = addDays(todayStr, 365); // look a full year ahead for discovery
  console.log(`Event scan — ${todayStr}`);

  // 1. Load existing cache
  console.log('  Loading existing events cache...');
  const cache = readCache();
  const existingEvents = cache.events || [];
  console.log(`  → ${existingEvents.length} events in cache`);

  // 2. Prune stale events (past end_date by >30 days) to keep cache tidy
  const pruneDate = addDays(todayStr, -30);
  const pruned = existingEvents.filter(ev => ev.end_date >= pruneDate);
  if (pruned.length < existingEvents.length) {
    console.log(`  Pruned ${existingEvents.length - pruned.length} past events`);
  }

  // 3. Fetch fresh events from all sources
  const freshEvents = [];

  // Ticketmaster — all 3 markets in parallel
  if (TM_KEY) {
    console.log('  Scanning Ticketmaster...');
    const tmResults = await Promise.all(
      Object.values(MARKETS).map(async market => {
        const events = await fetchTicketmaster(market, todayStr, scanEnd);
        console.log(`    ${market}: ${events.length} events`);
        return events;
      })
    );
    freshEvents.push(...tmResults.flat());
  }

  // ESPN sports schedules
  console.log('  Scanning ESPN sports schedules...');
  const espnEvents = await fetchAllSportsEvents();
  const futureEspn = espnEvents.filter(ev => ev.start_date >= todayStr);
  freshEvents.push(...futureEspn);

  // Tavily web search — discovers events not on Ticketmaster
  console.log('  Scanning web for events (Tavily + Claude)...');
  try {
    const webEvents = await webSearchEvents(parseInt(todayStr.slice(0, 4)));
    const futureWeb = webEvents.filter(ev => ev.start_date >= todayStr);
    freshEvents.push(...futureWeb);
    console.log(`  Web search found: ${futureWeb.length} events`);
  } catch (e) {
    console.warn(`  Web search failed (skipping): ${e.message}`);
  }

  console.log(`  Total fresh events: ${freshEvents.length}`);

  // 4. Merge with existing cache, identify new events
  const { allEvents, newEvents } = mergeEvents(pruned, freshEvents);
  console.log(`  New events discovered: ${newEvents.length}`);

  // 5. Write updated cache
  const updatedCache = {
    last_updated: new Date().toISOString(),
    scan_date: todayStr,
    events: allEvents,
  };
  console.log('  Writing updated cache to disk...');
  writeCache(updatedCache);
  console.log(`  ✓ Cache updated: ${allEvents.length} total events → ${CACHE_PATH}`);

  // 6. Alert email — only for high/very-high impact new events
  const alertableNew = newEvents.filter(ev => ev.impact === 'high' || ev.impact === 'very-high');
  if (alertableNew.length > 0) {
    console.log(`  Sending alert email for ${alertableNew.length} high-impact new event(s)...`);
    try {
      const result = await sendAlertEmail(alertableNew);
      console.log(`  ✓ Alert sent! ID: ${result.id}`);
    } catch (e) {
      console.error(`  Alert email failed: ${e.message}`);
    }
  } else if (newEvents.length > 0) {
    console.log(`  ${newEvents.length} new moderate/low events added to cache — no alert (below threshold)`);
  } else {
    console.log('  No new events — no alert needed');
  }

  if (newEvents.length > 0) {
    console.log('\n  New events by impact:');
    for (const ev of newEvents.sort((a, b) => (b.impact === 'very-high' ? 1 : 0) - (a.impact === 'very-high' ? 1 : 0))) {
      console.log(`    [${ev.impact.toUpperCase()}] [${ev.market}] ${ev.name} (${ev.start_date})`);
    }
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
