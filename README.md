# Troop TX-0521 Website

The public website for Trail Life Troop TX-0521 (Van Alstyne, TX), a ministry of The Crossroads Community Church. A static rebuild of the previous WordPress/Elementor site, plus a live event calendar synced from TrailLifeConnect.

## Tech stack

- **[Astro](https://astro.build)** — static site generator, `output: 'static'`. Pages and components are `.astro` files with TypeScript in the frontmatter.
- **Plain CSS** ([src/styles/global.css](src/styles/global.css)) — no framework. Brand colors, spacing, and per-program color themes (green/gray/blue for the three youth programs) are all CSS custom properties; no Tailwind, no CSS-in-JS.
- **[FullCalendar](https://fullcalendar.io)** (vanilla JS build, no React) — renders the `/calendar/` page from JSON served by our own API.
- **Cloudflare Workers** (with static assets) — hosts the whole site. Static pages are served directly from the built `dist/` folder; two dynamic routes run as the Worker's `fetch` handler ([worker/index.js](worker/index.js)): `/api/calendar` and `/api/contact`.
- **[ical.js](https://github.com/kewisch/ical.js)** — parses the troop's iCal feed server-side inside the Worker (the feed's CORS policy blocks fetching it directly from the browser).
- **Cloudflare KV** — a fallback cache for calendar data, used only if the edge cache misses *and* the live upstream fetch fails.
- **Cloudflare Email Routing** (the `send_email` binding) + **[mimetext](https://github.com/muratgozel/MIMEText)** — sends Contact form submissions as real email, no third-party email provider involved.
- **[@astrojs/sitemap](https://docs.astro.build/en/guides/integrations-guide/sitemap/)** — generates `sitemap-index.xml` at build time; `public/robots.txt` points at it.
- No trailing slashes: `trailingSlash: 'never'` in `astro.config.mjs`, paired with `html_handling = "drop-trailing-slash"` in `wrangler.toml` so Cloudflare's own asset serving redirects `/about/` → `/about` rather than the other way around.

## Project structure

```text
src/
  components/   Header, Navigation (recursive, multi-level), Section, Card, LeadershipCard, JoinCta,
                 HotspotImage (interactive image hotspots), ScrollToTop
  data/          navigation.ts — the site's nav tree
  layouts/       BaseLayout, PageLayout (page-hero + optional per-program theme)
  pages/         index, about/, about/{join,woodlands-trail,navigators,adventurers,uniforms}/,
                 calendar/, contact/, 404
  styles/        global.css — brand palette, layout, per-program themes
worker/
  index.js       The site's dynamic routes: GET /api/calendar, POST /api/contact
public/
  images/        Local copies of site imagery (no hotlinking to the old WordPress host)
  robots.txt     Points crawlers at the generated sitemap
wrangler.toml    Worker config: static assets binding (404 page, drop-trailing-slash), KV binding,
                 send_email binding, observability
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

`npm run dev` only knows about `src/` — it has no concept of the Worker's `fetch` handler, so the Calendar and Contact pages will show their fallback/error states there. That's expected; switch to `npm run worker:dev` whenever you're touching either.

`npm run worker:dev` needs the `CONTACT_TO_ADDRESS` secret to actually send mail locally. Create a `.dev.vars` file (already gitignored, never commit it) with:

```text
CONTACT_TO_ADDRESS=info@tx0521.org
```

## Deployment

The site deploys via Cloudflare's Git integration (Workers Builds): every merge to `master` triggers an automatic build (`npm run build`) and deploy, using the bindings declared in `wrangler.toml` (static assets, the `CALENDAR_KV` namespace, the `CONTACT_EMAIL` send_email binding). Non-`master` branches are **not** built by Cloudflare — that's what CI is for.

One thing Cloudflare's Git integration does **not** provision: the `CONTACT_TO_ADDRESS` secret (deliberately not a `wrangler.toml` var — see Contact form architecture below). Set it once per environment with:

```bash
wrangler secret put CONTACT_TO_ADDRESS
```

## Contributing / CI

`master` is protected: all changes go through a pull request (enforced for everyone, no direct pushes). Every PR runs [.github/workflows/ci.yml](.github/workflows/ci.yml) — lint, typecheck, and build — as a required status check.

## Calendar architecture

`/calendar/` renders FullCalendar against `/api/calendar`, a same-origin JSON endpoint. The Worker fetches the troop's TrailLifeConnect iCal feed server-side (its CORS policy only allows requests from traillifeconnect.com's own origins), expands recurring events into concrete instances, and caches the result two ways:

1. **Cloudflare's edge Cache API** — the fast path, 15-minute TTL. A hit means no KV read and no upstream fetch at all.
2. **KV** — written on every successful upstream fetch, read only as a fallback if the edge cache misses *and* the live fetch to TrailLifeConnect fails. This is what lets the calendar degrade to "slightly stale" instead of broken if the feed is ever down.

## Contact form architecture

`/contact/` posts JSON to `/api/contact`. The Worker validates the fields server-side, then sends the message as a real email using Cloudflare's own Email Routing (the `CONTACT_EMAIL` send_email binding) rather than a third-party email API — `tx0521.org`'s DNS already lives on Cloudflare with Email Routing configured, and `info@tx0521.org` is a verified destination address there, so the Worker sends straight to it.

The recipient address is a Wrangler secret (`CONTACT_TO_ADDRESS`), not a `wrangler.toml` var, on purpose — vars are committed to the repo, secrets aren't. Even though `info@tx0521.org` is already public on the site, keeping it out of source control means the destination can change without a code change or exposing it in git history.

Spam mitigation is layered:

1. A hidden honeypot field (`website`) — a real visitor never sees or fills it; a submission with it filled in gets a fake success response with no email sent.
2. Server-side field validation (required fields, ZIP format, phone digit count, email shape) — the same checks the client-side masking/`required` attributes enforce, re-checked server-side since the client can't be trusted.
3. [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/) — an invisible bot-verification widget (`data-appearance="interaction-only"`, so it only ever shows a challenge if Cloudflare's risk engine decides one is actually needed) gates the handler with a server-side `siteverify` call, checked before the honeypot/validation logic runs. The widget's sitekey is a public constant in `contact/index.astro`; the `TURNSTILE_SECRET` is a Wrangler secret, and the set of hostnames a token is allowed to have been solved on (`TURNSTILE_HOSTNAMES`) is a committed `wrangler.toml` var — none of that is sensitive.
