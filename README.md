# Troop TX-0521 Website

The public website for Trail Life Troop TX-0521 (Van Alstyne, TX), a ministry of The Crossroads Community Church. A static rebuild of the previous WordPress/Elementor site, plus a live event calendar synced from TrailLifeConnect.

## Tech stack

- **[Astro](https://astro.build)** — static site generator, `output: 'static'`. Pages and components are `.astro` files with TypeScript in the frontmatter.
- **Plain CSS** ([src/styles/global.css](src/styles/global.css)) — no framework. Brand colors, spacing, and per-program color themes (green/gray/blue for the three youth programs) are all CSS custom properties; no Tailwind, no CSS-in-JS.
- **[FullCalendar](https://fullcalendar.io)** (vanilla JS build, no React) — renders the `/calendar/` page from JSON served by our own API.
- **Cloudflare Workers** (with static assets) — hosts the whole site. Static pages are served directly from the built `dist/` folder; one dynamic route, `/api/calendar`, runs as the Worker's `fetch` handler ([worker/index.js](worker/index.js)).
- **[ical.js](https://github.com/kewisch/ical.js)** — parses the troop's iCal feed server-side inside the Worker (the feed's CORS policy blocks fetching it directly from the browser).
- **Cloudflare KV** — a fallback cache for calendar data, used only if the edge cache misses *and* the live upstream fetch fails.

## Project structure

```text
src/
  components/   Header, Navigation (recursive, multi-level), Section, Card, LeadershipCard, JoinCta
  data/          navigation.ts — the site's nav tree
  layouts/       BaseLayout, PageLayout (page-hero + optional per-program theme)
  pages/         index, about/, about/{join,woodlands-trail,navigators,adventurers}/, calendar/
  styles/        global.css — brand palette, layout, per-program themes
worker/
  index.js       The site's one dynamic route: GET /api/calendar
public/
  images/        Local copies of site imagery (no hotlinking to the old WordPress host)
wrangler.toml    Worker config: static assets binding, KV binding, observability
```

## Commands

| Command               | Action                                                         |
| :--------------------- | :-------------------------------------------------------------- |
| `npm install`          | Install dependencies                                             |
| `npm run dev`          | Astro dev server at `localhost:4321` — fast reload, but `/api/calendar` isn't available here (see below) |
| `npm run worker:dev`   | Build, then run the *actual* Worker locally via Wrangler — use this to test the calendar/API |
| `npm run build`        | Build the static site to `./dist/`                               |
| `npm run lint`         | ESLint (`.astro` + `.js`)                                        |
| `npm run typecheck`    | `astro check` — type-checks `.astro` frontmatter                 |
| `npm run deploy`       | Manual deploy via `wrangler deploy` (normally not needed — see Deployment) |

`npm run dev` only knows about `src/` — it has no concept of the Worker's `fetch` handler, so the Calendar page will show its "couldn't load" fallback there. That's expected; switch to `npm run worker:dev` whenever you're touching the calendar.

## Deployment

The site deploys via Cloudflare's Git integration (Workers Builds): every merge to `master` triggers an automatic build (`npm run build`) and deploy, using the bindings declared in `wrangler.toml` (static assets + the `CALENDAR_KV` namespace). Non-`master` branches are **not** built by Cloudflare — that's what CI is for.

## Contributing / CI

`master` is protected: all changes go through a pull request (enforced for everyone, no direct pushes). Every PR runs [.github/workflows/ci.yml](.github/workflows/ci.yml) — lint, typecheck, and build — as a required status check.

## Calendar architecture

`/calendar/` renders FullCalendar against `/api/calendar`, a same-origin JSON endpoint. The Worker fetches the troop's TrailLifeConnect iCal feed server-side (its CORS policy only allows requests from traillifeconnect.com's own origins), expands recurring events into concrete instances, and caches the result two ways:

1. **Cloudflare's edge Cache API** — the fast path, 15-minute TTL. A hit means no KV read and no upstream fetch at all.
2. **KV** — written on every successful upstream fetch, read only as a fallback if the edge cache misses *and* the live fetch to TrailLifeConnect fails. This is what lets the calendar degrade to "slightly stale" instead of broken if the feed is ever down.
