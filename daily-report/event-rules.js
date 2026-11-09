// event-rules.js — sanity rules for web-search events, shared by scan-events.js
// (applied to new finds and to the cache on every scan) and index.js (applied when
// the daily report reads the cache). One copy, so the two can't drift apart.

export function isValidIsoDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T00:00:00Z'));
}

// An event's dates must be real, end on or after the start, and span at most this many days
export const MAX_EVENT_SPAN_DAYS = 31;
export function datesOk(ev) {
  if (!isValidIsoDate(ev.start_date) || !isValidIsoDate(ev.end_date)) return false;
  const span = (Date.parse(ev.end_date) - Date.parse(ev.start_date)) / 86400000;
  return span >= 0 && span <= MAX_EVENT_SPAN_DAYS;
}

// Titles of listing pages, calendars, guides and social posts, not single events
const LISTING_TITLE = new RegExp([
  String.raw`^\s*events? from\b`,
  String.raw`\b(upcoming|annual|winter|summer|fall|spring|local)\s+events\b`,
  String.raw`\bevents\s+(in|near|at|this)\b`,
  String.raw`\bfestivals\s+(19|20)\d{2}\b`,
  String.raw`\b(things to do|list of|best events|calendar|what to do|guide to|lineup is here)\b`,
  String.raw`\b\d+(\.\d+)?k?\s+(views|reactions|likes|comments)\b`,
  String.raw`\btickets are on sale\b`,
  String.raw`^\s*(home|instagram|facebook|tiktok|youtube|events|calendar)\s*$`,
].join('|'), 'i');
// Social media and listing/calendar pages
const LISTING_URL = /\/\/(?:[a-z0-9-]+\.)*(facebook|instagram|tiktok|youtube|twitter|x|reddit|pinterest)\.com\/|\/(?:local-)?events\/?(?:list|page|$)|\/list\/|\/page\/\d+|\/annual-events|\/blog\/|\/festival-guide\/|\/news-events\//i;

export const sourceUrl = ev => (ev.notes || '').match(/Source:\s*(\S+)/)?.[1] || '';
export const isListing = (name, url) => LISTING_TITLE.test(name || '') || LISTING_URL.test(url || '');

// Clean cached events: drop web-search entries that fail the rules above,
// and hold broad-search finds at moderate impact (they no longer trigger alerts)
export function cleanCachedWebEvents(events) {
  const kept = [], dropped = [];
  for (const ev of events) {
    if (ev.source !== 'web-search') { kept.push(ev); continue; }
    if (!datesOk(ev) || (ev.id?.startsWith('web-discover-') && isListing(ev.name, sourceUrl(ev)))) { dropped.push(ev); continue; }
    kept.push(ev.id?.startsWith('web-discover-') && ev.impact !== 'moderate' ? { ...ev, impact: 'moderate' } : ev);
  }
  return { kept, dropped };
}
