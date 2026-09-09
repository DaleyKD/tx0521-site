// Cloudflare Worker (with static assets) — the site's only dynamic route.
//
// Static assets (everything under dist/) are served automatically by the
// platform before this Worker ever runs — this fetch handler only receives
// requests that didn't match a built file, which in practice today is just
// GET /api/calendar.
//
// Serves the troop's TrailLifeConnect iCal feed as JSON for FullCalendar. The
// feed itself only allows browser fetches from traillifeconnect.com's own
// origins (checked via `curl -I`), so the browser can never fetch it directly —
// this Worker does the fetch server-side (no CORS there) and the browser only
// ever talks to our own /api/calendar, same-origin.
//
// Caching is two-tier:
//   1. Cloudflare's edge Cache API — the fast path, no KV read, no upstream
//      fetch, on every cache hit. This is what actually makes Cache-Control
//      headers do something for a Worker response (unlike a plain static
//      asset, a Worker response is NOT auto-cached by Cloudflare just because
//      it carries a Cache-Control header — it has to be put in the Cache API
//      explicitly).
//   2. KV — written on every successful upstream fetch, and read only as a
//      fallback when the Cache API misses AND the live upstream fetch fails
//      (feed down, changed shape, rate-limited, etc.). This is what lets us
//      degrade to "slightly stale calendar" instead of "broken calendar".
import ICAL from 'ical.js';

const ICAL_FEED_URL = 'https://www.traillifeconnect.com/icalendar/tkbapf3m5536/na/public';
const KV_KEY = 'calendar-events-v1';
const CACHE_TTL_SECONDS = 900; // 15 minutes

// How far back/forward to expand recurring events (weekly troop meetings, etc.)
// into concrete instances, so the client never needs an RRULE-aware calendar plugin.
const WINDOW_PAST_DAYS = 60;
const WINDOW_FUTURE_DAYS = 365;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/calendar' && request.method === 'GET') {
      return handleCalendar(request, env, ctx);
    }

    // Anything else reaching the Worker didn't match a static file or a known
    // route — a genuine 404, not a fallback to try rendering.
    return new Response('Not found', { status: 404 });
  },
};

async function handleCalendar(request, env, ctx) {
  const cache = caches.default;
  const cacheKey = new Request(new URL('/api/calendar', request.url).toString(), { method: 'GET' });

  const cachedResponse = await cache.match(cacheKey);
  if (cachedResponse) return withCacheStatus(cachedResponse, 'edge-hit');

  try {
    const events = await fetchAndParse();
    const response = jsonResponse(events, 'miss');
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    ctx.waitUntil(writeKvBackup(env, events));
    return response;
  } catch (err) {
    // Upstream is down or the feed changed shape — fall back to the last known
    // good copy in KV rather than showing a broken calendar.
    const stale = await readKvBackup(env);
    if (stale) return jsonResponse(stale.events, 'kv-fallback');
    return new Response(JSON.stringify({ error: 'Unable to load calendar', detail: String(err) }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    });
  }
}

async function readKvBackup(env) {
  if (!env.CALENDAR_KV) return null;
  try {
    return await env.CALENDAR_KV.get(KV_KEY, { type: 'json' });
  } catch {
    return null;
  }
}

async function writeKvBackup(env, events) {
  if (!env.CALENDAR_KV) return;
  try {
    await env.CALENDAR_KV.put(KV_KEY, JSON.stringify({ events, fetchedAt: Date.now() }));
  } catch {
    // KV write failures shouldn't break the response — the fresh data has already been returned.
  }
}

function jsonResponse(events, cacheStatus) {
  return new Response(JSON.stringify(events), {
    headers: {
      'content-type': 'application/json',
      'cache-control': `public, max-age=${CACHE_TTL_SECONDS}`,
      'x-calendar-cache': cacheStatus,
    },
  });
}

function withCacheStatus(response, status) {
  const headers = new Headers(response.headers);
  headers.set('x-calendar-cache', status);
  return new Response(response.body, { status: response.status, headers });
}

async function fetchAndParse() {
  const res = await fetch(ICAL_FEED_URL, {
    headers: { 'User-Agent': 'Troop TX-0521 Calendar Sync (tx0521.org)' },
  });
  if (!res.ok) throw new Error(`Upstream returned ${res.status}`);
  const icsText = await res.text();
  return parseIcs(icsText);
}

function parseIcs(icsText) {
  const jcalData = ICAL.parse(icsText);
  const comp = new ICAL.Component(jcalData);
  const vevents = comp.getAllSubcomponents('vevent');

  const rangeStart = ICAL.Time.fromJSDate(new Date(Date.now() - WINDOW_PAST_DAYS * 86400000));
  const rangeEnd = ICAL.Time.fromJSDate(new Date(Date.now() + WINDOW_FUTURE_DAYS * 86400000));

  const events = [];
  for (const ve of vevents) {
    const event = new ICAL.Event(ve);
    if (!event.startDate) continue;

    if (event.isRecurring()) {
      const iterator = event.iterator();
      let next;
      let guard = 0;
      // A safety guard in case a feed ever has an unbounded recurrence with no
      // sensible UNTIL — never loop more than a few thousand times.
      while ((next = iterator.next()) && guard++ < 3000) {
        if (next.compare(rangeEnd) > 0) break;
        if (next.compare(rangeStart) < 0) continue;
        const details = event.getOccurrenceDetails(next);
        events.push(toPlainEvent(details.item, details.startDate, details.endDate));
      }
    } else if (event.startDate.compare(rangeStart) >= 0 && event.startDate.compare(rangeEnd) <= 0) {
      events.push(toPlainEvent(event, event.startDate, event.endDate));
    }
  }

  events.sort((a, b) => a.start.localeCompare(b.start));
  return events;
}

function toPlainEvent(event, startTime, endTime) {
  return {
    id: `${event.uid}-${startTime.toString()}`,
    title: event.summary || 'Untitled Event',
    start: startTime.toJSDate().toISOString(),
    end: endTime ? endTime.toJSDate().toISOString() : undefined,
    allDay: startTime.isDate,
    location: event.location || '',
    description: event.description || '',
  };
}
