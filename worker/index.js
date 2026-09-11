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
import { EmailMessage } from 'cloudflare:email';
import { createMimeMessage, Mailbox } from 'mimetext';

const ICAL_FEED_URL = 'https://www.traillifeconnect.com/icalendar/tkbapf3m5536/na/public';
const KV_KEY = 'calendar-events-v1';
const CACHE_TTL_SECONDS = 900; // 15 minutes

// The sending address isn't sensitive (it's a fixed, non-personal "noreply"
// address), so it's fine as a plain constant. The destination address is a
// Wrangler secret instead of a constant/wrangler.toml var — set via
// `wrangler secret put CONTACT_TO_ADDRESS` — so it never lives in the repo,
// even though info@tx0521.org itself is already public on the site today.
const CONTACT_FROM_ADDRESS = 'noreply@tx0521.org';

const TURNSTILE_ACTION = 'contact';
const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

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

    if (url.pathname === '/api/contact' && request.method === 'POST') {
      return handleContact(request, env);
    }

    // Anything else reaching the Worker didn't match a static file or a known
    // route — a genuine 404. Defer to the assets binding so the custom
    // dist/404.html (wrangler.toml's not_found_handling = "404-page") is what
    // actually gets served, instead of a bare text response.
    return env.ASSETS.fetch(request);
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
    console.error('Calendar fetch failed', err);
    return new Response(JSON.stringify({ error: 'Unable to load calendar' }), {
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

// POST /api/contact — sends a plain-text email through Cloudflare's own Email
// Routing (the `CONTACT_EMAIL` send_email binding) to the troop's contact
// address, which is already configured in the zone to forward to the real
// inbox. No third-party email provider or API key involved.
async function handleContact(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return contactError('Invalid request body.', 400);
  }

  const verified = await verifyTurnstile(body['cf-turnstile-response'], env, request);
  if (!verified) return contactError('We could not verify you are human. Please try again.', 403);

  // Honeypot: a hidden field real visitors never see or fill in. A bot that
  // fills every field on the form trips this; respond as if it worked so the
  // bot doesn't learn anything, but never send the email.
  if (typeof body.website === 'string' && body.website.trim() !== '') {
    return contactSuccess();
  }

  const fields = validateContactFields(body);
  if (fields.error) return contactError(fields.error, 422);

  if (!env.CONTACT_EMAIL || !env.CONTACT_TO_ADDRESS) {
    return contactError('Contact form is not configured.', 500);
  }

  try {
    const msg = createMimeMessage();
    msg.setSender({ name: 'Troop TX-0521 Website', addr: CONTACT_FROM_ADDRESS });
    msg.setRecipient(env.CONTACT_TO_ADDRESS);
    msg.setHeader('Reply-To', new Mailbox(fields.email));
    msg.setSubject(`Contact form: ${fields.firstName} ${fields.lastName}`);
    msg.addMessage({
      contentType: 'text/plain',
      data: [
        `Name: ${fields.firstName} ${fields.lastName}`,
        `Email: ${fields.email}`,
        `Phone: ${fields.phone}`,
        `ZIP Code: ${fields.zip}`,
        '',
        'Message:',
        fields.message,
      ].join('\n'),
    });

    const email = new EmailMessage(CONTACT_FROM_ADDRESS, env.CONTACT_TO_ADDRESS, msg.asRaw());
    await env.CONTACT_EMAIL.send(email);
    return contactSuccess();
  } catch (err) {
    return contactError('Unable to send your message right now. Please try again shortly.', 502, err);
  }
}

// Verifies a Turnstile token server-side via Cloudflare's siteverify endpoint.
// Never trust the browser's word alone — the token only proves anything once
// siteverify confirms success, the expected action, and an approved hostname.
async function verifyTurnstile(token, env, request) {
  const expectedHostnames = new Set(
    (env.TURNSTILE_HOSTNAMES ?? '')
      .split(',')
      .map((hostname) => hostname.trim())
      .filter(Boolean),
  );

  if (typeof token !== 'string' || token.length === 0 || token.length > 2048) return false;
  if (!env.TURNSTILE_SECRET || expectedHostnames.size === 0) return false;

  let result;
  try {
    const res = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(10_000),
      body: new URLSearchParams({
        secret: env.TURNSTILE_SECRET,
        response: token,
        remoteip: request.headers.get('cf-connecting-ip') ?? '',
      }),
    });
    if (!res.ok) throw new Error(`siteverify ${res.status}`);
    result = await res.json();
  } catch {
    return false; // Network error, non-2xx, or non-JSON body — fail closed.
  }

  return Boolean(
    result.success && result.action === TURNSTILE_ACTION && expectedHostnames.has(result.hostname),
  );
}

function validateContactFields(body) {
  const firstName = trimTo(body.firstName, 100);
  const lastName = trimTo(body.lastName, 100);
  const zip = trimTo(body.zip, 10);
  const phone = trimTo(body.phone, 30);
  const email = trimTo(body.email, 200);
  const message = trimTo(body.message, 5000);

  if (!firstName || !lastName) return { error: 'Please enter your first and last name.' };
  if (!/^\d{5}(-\d{4})?$/.test(zip)) return { error: 'Please enter a valid ZIP code.' };
  if (!phone || phone.replace(/\D/g, '').length < 10) return { error: 'Please enter a valid phone number.' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: 'Please enter a valid email address.' };
  if (!message) return { error: 'Please enter a message.' };

  return { firstName, lastName, zip, phone, email, message };
}

function trimTo(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function contactSuccess() {
  return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
}

function contactError(error, status, cause) {
  if (cause) console.error('Contact form error', cause);
  return new Response(JSON.stringify({ ok: false, error }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
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
