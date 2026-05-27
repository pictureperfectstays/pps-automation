// events-calendar.js
// Hardcoded recurring/seasonal events for all 3 markets.
// Ticketmaster-discovered events and sports schedules are handled by scan-events.js.
// This file covers predictable annual events with known approximate date windows.

export const MARKETS = {
  SCOTTSDALE: 'Scottsdale',
  SEVIERVILLE: 'Sevierville',
  PCB: 'Panama City Beach',
};

export const MARKET_COORDS = {
  [MARKETS.SCOTTSDALE]: { lat: 33.5016, lng: -111.916, radius: 50 },
  [MARKETS.SEVIERVILLE]: { lat: 35.868,  lng: -83.562,  radius: 30 },
  [MARKETS.PCB]:         { lat: 30.176,  lng: -85.805,  radius: 30 },
};

// Property → market mapping
export const PROP_MARKET = {
  5: MARKETS.PCB,
  6: MARKETS.SEVIERVILLE,
  7: MARKETS.SCOTTSDALE,
  8: MARKETS.SCOTTSDALE,
};

// ─── Date helpers ──────────────────────────────────────────────────────────────

function isoDate(d) { return d.toISOString().slice(0, 10); }

function addDaysToStr(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Returns last occurrence of a given day-of-week in a month (0=Sun … 6=Sat)
function lastDowOfMonth(year, month, dow) {
  const lastDay = new Date(Date.UTC(year, month, 0)); // month is 1-indexed here
  const lastDow = lastDay.getUTCDay();
  const daysBack = (lastDow - dow + 7) % 7;
  return new Date(Date.UTC(year, month - 1, lastDay.getUTCDate() - daysBack));
}

// Gulf Coast Jam: first Thursday on or after May 28 each year
// (Frank Brown Park, Panama City Beach — late May, 4-day country festival)
// Pattern verified: 2024 May 30–Jun 2, 2025 May 29–Jun 1, 2026 May 28–31
function gulfCoastJamDates(year) {
  const may28 = new Date(Date.UTC(year, 4, 28)); // month 4 = May (0-indexed)
  const dow = may28.getUTCDay(); // 0=Sun … 4=Thu … 6=Sat
  const daysToThu = (4 - dow + 7) % 7; // 0 if already Thursday
  const thu = new Date(Date.UTC(year, 4, 28 + daysToThu));
  const start = isoDate(thu);
  return {
    id: `gulf-coast-jam-${year}`,
    name: 'Gulf Coast Jam (Country Music)',
    market: MARKETS.PCB,
    start_date: start,
    end_date: addDaysToStr(start, 3),
    impact: 'high',
    is_watch: false,
    source: 'hardcoded',
    notes: 'Computed: first Thursday on or after May 28. Verify at gulfcoastjam.com.',
  };
}

// Thunder Beach runs last Thursday–Sunday of April (spring) and October (fall)
function thunderBeachDates(year) {
  return [['Spring', 4], ['Fall', 10]].map(([label, month]) => {
    const thu = lastDowOfMonth(year, month, 4);
    const start = isoDate(thu);
    return {
      id: `thunder-beach-${label.toLowerCase()}-${year}`,
      name: `Thunder Beach Motorcycle Rally (${label})`,
      market: MARKETS.PCB,
      start_date: start,
      end_date: addDaysToStr(start, 3),
      impact: 'high',
      is_watch: false,
      source: 'hardcoded',
      notes: 'Computed: last Thursday–Sunday of month. Verify at thunderbeach.org for exact dates.',
    };
  });
}

// ─── Recurring event definitions ───────────────────────────────────────────────
// month_end < month_start means the event wraps into the following calendar year.

const RECURRING = [

  // ── SCOTTSDALE ────────────────────────────────────────────────────────────

  { id_base: 'rock-roll-az-marathon', name: "Rock 'n' Roll Arizona Marathon",
    market: MARKETS.SCOTTSDALE, ms: 1, ds: 17, me: 1, de: 19,
    impact: 'low-moderate', notes: 'Downtown Phoenix. Runners and spectators fill Scottsdale hotels.' },

  { id_base: 'barrett-jackson-scottsdale', name: 'Barrett-Jackson Scottsdale Auction',
    market: MARKETS.SCOTTSDALE, ms: 1, ds: 11, me: 1, de: 19,
    impact: 'very-high', notes: 'WestWorld of Scottsdale. Dates shift slightly year to year — Ticketmaster will refine.' },

  { id_base: 'wm-phoenix-open', name: 'WM Phoenix Open (Golf)',
    market: MARKETS.SCOTTSDALE, ms: 1, ds: 26, me: 2, de: 1,
    impact: 'very-high', notes: 'TPC Scottsdale. One of the most-attended golf events in the world. Dates fluctuate ~1 week.' },

  { id_base: 'arabian-horse-show', name: 'Scottsdale Arabian Horse Show',
    market: MARKETS.SCOTTSDALE, ms: 2, ds: 5, me: 2, de: 15,
    impact: 'moderate', notes: 'WestWorld of Scottsdale.' },

  { id_base: 'innings-festival', name: 'Innings Festival (Music + Baseball)',
    market: MARKETS.SCOTTSDALE, ms: 2, ds: 21, me: 2, de: 22,
    impact: 'moderate', notes: 'Tempe Beach Park.' },

  { id_base: 'cactus-league', name: 'Cactus League Spring Training',
    market: MARKETS.SCOTTSDALE, ms: 2, ds: 20, me: 3, de: 28,
    impact: 'moderate', notes: '15 MLB teams across the Valley. Scottsdale Stadium hosts Giants & Rockies.' },

  { id_base: 'az-renaissance-festival', name: 'Arizona Renaissance Festival',
    market: MARKETS.SCOTTSDALE, ms: 2, ds: 7, me: 3, de: 29,
    impact: 'low-moderate', notes: 'Apache Junction (~35 mi). Weekends only through late March.' },

  { id_base: 'scottsdale-arts-festival', name: 'Scottsdale Arts Festival',
    market: MARKETS.SCOTTSDALE, ms: 3, ds: 6, me: 3, de: 8,
    impact: 'low-moderate', notes: 'Scottsdale Civic Center.' },

  { id_base: 'spring-break-scottsdale', name: 'Spring Break — Scottsdale',
    market: MARKETS.SCOTTSDALE, ms: 3, ds: 7, me: 4, de: 5,
    impact: 'moderate', notes: 'ASU spring break and national spring break drive significant demand.' },

  { id_base: 'tempe-festival-arts-spring', name: 'Tempe Festival of the Arts (Spring)',
    market: MARKETS.SCOTTSDALE, ms: 3, ds: 27, me: 3, de: 29,
    impact: 'moderate', notes: 'Mill Avenue, Tempe.' },

  { id_base: 'country-thunder-az', name: 'Country Thunder Arizona',
    market: MARKETS.SCOTTSDALE, ms: 4, ds: 16, me: 4, de: 19,
    impact: 'moderate', notes: 'Florence, AZ (~45 mi south). 4-day country music festival.' },

  { id_base: 'phoenix-pride', name: 'Phoenix Pride Festival',
    market: MARKETS.SCOTTSDALE, ms: 4, ds: 18, me: 4, de: 19,
    impact: 'moderate', notes: 'Steele Indian School Park, Phoenix.' },

  { id_base: 'scottsdale-culinary-festival', name: 'Scottsdale Culinary Festival',
    market: MARKETS.SCOTTSDALE, ms: 4, ds: 16, me: 4, de: 19,
    impact: 'low-moderate', notes: 'Old Town Scottsdale.' },

  { id_base: 'phoenix-fan-fusion', name: 'Phoenix Fan Fusion (Comic-Con)',
    market: MARKETS.SCOTTSDALE, ms: 5, ds: 28, me: 5, de: 31,
    impact: 'moderate', notes: 'Phoenix Convention Center. Dates vary late May to early June — Ticketmaster will refine.' },

  { id_base: 'scottsdale-summer-watch', name: 'Summer Slow Season ⚠ Scottsdale',
    market: MARKETS.SCOTTSDALE, ms: 6, ds: 1, me: 8, de: 31,
    impact: 'watch', is_watch: true,
    notes: 'Extreme heat suppresses demand. Price at or BELOW market median. Do not chase premium pricing.' },

  { id_base: 'tempe-festival-arts-fall', name: 'Tempe Festival of the Arts (Fall)',
    market: MARKETS.SCOTTSDALE, ms: 12, ds: 5, me: 12, de: 7,
    impact: 'moderate', notes: 'Mill Avenue, Tempe.' },

  { id_base: 'fiesta-bowl', name: 'Fiesta Bowl Weekend',
    market: MARKETS.SCOTTSDALE, ms: 12, ds: 28, me: 1, de: 2,
    impact: 'high', notes: 'State Farm Stadium, Glendale (~20 mi). Ticketmaster will surface specific game details.' },

  // ── SEVIERVILLE ───────────────────────────────────────────────────────────

  { id_base: 'wilderness-wildlife-week', name: 'Wilderness Wildlife Week',
    market: MARKETS.SEVIERVILLE, ms: 1, ds: 14, me: 1, de: 18,
    impact: 'low-moderate', notes: 'Pigeon Forge. Free nature education programs, family-oriented.' },

  { id_base: 'bristol-nascar-spring', name: 'NASCAR at Bristol Motor Speedway (Spring)',
    market: MARKETS.SEVIERVILLE, ms: 3, ds: 27, me: 3, de: 30,
    impact: 'high', notes: 'Bristol, TN (~75 mi). Huge attendance — fills lodging region-wide.' },

  { id_base: 'spring-wildflowers', name: 'Spring Wildflower Season — Smokies',
    market: MARKETS.SEVIERVILLE, ms: 4, ds: 1, me: 5, de: 31,
    impact: 'moderate', notes: 'Appalachian wildflowers drive significant nature tourism.' },

  { id_base: 'dollywood-flower-food', name: 'Dollywood Flower & Food Festival',
    market: MARKETS.SEVIERVILLE, ms: 4, ds: 25, me: 6, de: 14,
    impact: 'moderate', notes: 'Dollywood theme park, Pigeon Forge.' },

  { id_base: 'smoky-mountains-bike-week', name: 'Smoky Mountains Bike Week (ROAM)',
    market: MARKETS.SEVIERVILLE, ms: 5, ds: 14, me: 5, de: 18,
    impact: 'moderate', notes: 'Sevierville Fairgrounds. Major motorcycle rally.' },

  { id_base: 'summer-peak-sevierville', name: 'Summer Peak Season — Smokies',
    market: MARKETS.SEVIERVILLE, ms: 5, ds: 24, me: 9, de: 1,
    impact: 'high', notes: 'Memorial Day through Labor Day. Strong demand — genuine peak unlike Scottsdale.' },

  { id_base: 'gatlinburg-craftsmens-summer', name: "Gatlinburg Craftsmen's Fair (Summer)",
    market: MARKETS.SEVIERVILLE, ms: 7, ds: 18, me: 7, de: 26,
    impact: 'low-moderate', notes: 'Gatlinburg Convention Center.' },

  { id_base: 'national-quartet-convention', name: 'National Quartet Convention (Gospel)',
    market: MARKETS.SEVIERVILLE, ms: 9, ds: 1, me: 9, de: 6,
    impact: 'moderate', notes: 'LeConte Center, Pigeon Forge. ~30,000 attendees annually.' },

  { id_base: 'bristol-nascar-fall', name: 'NASCAR at Bristol Motor Speedway (Fall Night Race)',
    market: MARKETS.SEVIERVILLE, ms: 9, ds: 19, me: 9, de: 21,
    impact: 'high', notes: 'Bristol, TN (~75 mi). The night race is one of the most-attended events in NASCAR.' },

  { id_base: 'shades-past-rod-run', name: "Shades of the Past Rod Run",
    market: MARKETS.SEVIERVILLE, ms: 10, ds: 2, me: 10, de: 4,
    impact: 'moderate', notes: 'Pigeon Forge. Classic car show, 3,000+ vehicles.' },

  { id_base: 'dollywood-harvest', name: 'Dollywood Harvest Festival',
    market: MARKETS.SEVIERVILLE, ms: 10, ds: 1, me: 11, de: 2,
    impact: 'high', notes: 'Dollywood, Pigeon Forge.' },

  { id_base: 'fall-foliage-peak', name: 'Fall Foliage Peak — Smoky Mountains',
    market: MARKETS.SEVIERVILLE, ms: 10, ds: 10, me: 11, de: 10,
    impact: 'very-high',
    notes: 'Peak color Oct 15–25 at elevation, Oct 25–Nov 5 in valleys. Highest demand period of the year.' },

  { id_base: 'gatlinburg-craftsmens-fall', name: "Gatlinburg Craftsmen's Fair (Fall)",
    market: MARKETS.SEVIERVILLE, ms: 10, ds: 2, me: 10, de: 19,
    impact: 'low-moderate', notes: 'Gatlinburg Convention Center.' },

  { id_base: 'dollywood-christmas', name: 'Dollywood Smoky Mountain Christmas',
    market: MARKETS.SEVIERVILLE, ms: 11, ds: 6, me: 1, de: 5,
    impact: 'high', notes: 'One of the top holiday events in the Southeast.' },

  { id_base: 'pigeon-forge-winterfest', name: 'Pigeon Forge Winterfest (Lights)',
    market: MARKETS.SEVIERVILLE, ms: 11, ds: 1, me: 2, de: 28,
    impact: 'moderate', notes: 'Holiday light displays drive weekend visits Nov–Feb.' },

  // ── PANAMA CITY BEACH ─────────────────────────────────────────────────────

  { id_base: 'pcb-mardi-gras', name: 'Panama City Beach Mardi Gras',
    market: MARKETS.PCB, ms: 2, ds: 14, me: 3, de: 1,
    impact: 'low-moderate', notes: 'Dates shift with Mardi Gras calendar — Ticketmaster will surface specific events.' },

  { id_base: 'spring-break-pcb', name: 'Spring Break Peak — Panama City Beach',
    market: MARKETS.PCB, ms: 3, ds: 7, me: 4, de: 15,
    impact: 'very-high', notes: 'Largest demand period of the year for PCB.' },

  { id_base: 'seabreeze-jazz', name: 'Seabreeze Jazz Festival',
    market: MARKETS.PCB, ms: 4, ds: 22, me: 4, de: 26,
    impact: 'moderate', notes: 'Frank Brown Park. 30,000+ visitors.' },

  { id_base: 'emerald-coast-cruizin', name: "Emerald Coast Cruizin' (Car Show)",
    market: MARKETS.PCB, ms: 5, ds: 14, me: 5, de: 17,
    impact: 'moderate', notes: 'Panama City Beach. Major classic car show.' },

  { id_base: 'ironman-gulf-coast', name: 'Ironman 70.3 Gulf Coast',
    market: MARKETS.PCB, ms: 5, ds: 16, me: 5, de: 17,
    impact: 'low-moderate', notes: 'Panama City (adjacent to PCB). Athletes and spectators fill local lodging.' },

  { id_base: 'memorial-day-pcb', name: 'Memorial Day Weekend',
    market: MARKETS.PCB, ms: 5, ds: 23, me: 5, de: 26,
    impact: 'high', notes: '' },

  // Gulf Coast Jam moved to algorithmic computation — see gulfCoastJamDates()

  { id_base: 'summer-peak-pcb', name: 'Summer Peak Season — Panama City Beach',
    market: MARKETS.PCB, ms: 6, ds: 1, me: 8, de: 20,
    impact: 'very-high', notes: 'Genuine peak season. Price aggressively.' },

  { id_base: 'blue-angels-pensacola', name: 'Blue Angels Air Show (Pensacola)',
    market: MARKETS.PCB, ms: 7, ds: 10, me: 7, de: 12,
    impact: 'low-moderate', notes: 'NAS Pensacola (~1 hr from PCB). Many attendees stay in PCB.' },

  { id_base: 'labor-day-pcb', name: 'Labor Day Weekend',
    market: MARKETS.PCB, ms: 9, ds: 5, me: 9, de: 7,
    impact: 'high', notes: 'Last major summer weekend.' },

  { id_base: 'lobster-festival-pcb', name: 'Lobster Festival & Regatta',
    market: MARKETS.PCB, ms: 10, ds: 17, me: 10, de: 19,
    impact: 'moderate', notes: 'Frank Brown Park. Food festival + sailing regatta.' },

  { id_base: 'pepsi-gulf-coast-jam', name: 'Pepsi Gulf Coast Jam (Country — Fall)',
    market: MARKETS.PCB, ms: 11, ds: 6, me: 11, de: 8,
    impact: 'moderate', notes: 'Frank Brown Park.' },
];

function expandEvent(def, year) {
  const yearEnd = def.me < def.ms ? year + 1 : year;
  return {
    id: `${def.id_base}-${year}`,
    name: def.name,
    market: def.market,
    start_date: `${year}-${String(def.ms).padStart(2,'0')}-${String(def.ds).padStart(2,'0')}`,
    end_date: `${yearEnd}-${String(def.me).padStart(2,'0')}-${String(def.de).padStart(2,'0')}`,
    impact: def.impact,
    is_watch: def.is_watch || false,
    source: 'hardcoded',
    notes: def.notes || '',
  };
}

// Returns hardcoded events overlapping the next 120 days from todayStr
export function getHardcodedEvents(todayStr) {
  const year = parseInt(todayStr.slice(0, 4));
  const cutoff = addDaysToStr(todayStr, 120);
  const seen = new Set();
  const results = [];

  for (const def of RECURRING) {
    for (const y of [year - 1, year, year + 1]) {
      const ev = expandEvent(def, y);
      if (ev.end_date >= todayStr && ev.start_date <= cutoff && !seen.has(ev.id)) {
        seen.add(ev.id);
        results.push(ev);
      }
    }
  }

  for (const y of [year, year + 1]) {
    for (const ev of thunderBeachDates(y)) {
      if (ev.end_date >= todayStr && ev.start_date <= cutoff && !seen.has(ev.id)) {
        seen.add(ev.id);
        results.push(ev);
      }
    }
    const gcj = gulfCoastJamDates(y);
    if (gcj.end_date >= todayStr && gcj.start_date <= cutoff && !seen.has(gcj.id)) {
      seen.add(gcj.id);
      results.push(gcj);
    }
  }

  return results.sort((a, b) => a.start_date.localeCompare(b.start_date));
}
