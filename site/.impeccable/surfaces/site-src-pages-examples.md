---
version: 1
slug: "site-src-pages-examples"
primary_target: "site/src/pages/examples"
related_targets: []
---

# Examples console (Operate)

Mode: Operate. World: HoBo Rubberhose (site/DESIGN.md).

Structure: film-strip storyboard (concept seed 116fd7b0, grounded candidate 3).
Three boards lead — Stage nests **inside Live** (never above the strip):

1. **Pool** — yards via **dropdown multi-select** (`[data-yard-picker]` /
   `[data-yard-trigger]` + menu). Browser WASM + Webernetes are one **Local**
   option (`data-yard-option="local"` → both target ids). All / None toggles in
   the menu. Hidden `[data-yard-select]` stays synced for Playwright
   `selectOption`. Policy ↔ Code: Code synthesizes
   `export default station({ yards: […] })` from the provision plan
   (`composePoolDeploySource` → `[data-pool-source]`), importing
   `@hobo/provider-*` plugins — no hand-listed capabilities/bootstrap strings.
2. **Ship** — locked until Pool has stations; single app combobox + Bindle
   source on-board (`[data-ship-source]`)
3. **Live** — Preview ↔ Logs (terminal reel), deployment select, **claim URL
   panel** when anonymous/Temporary Accounts deploys issue one. No Claim CTA —
   codes are display-only for the user to claim elsewhere.

No plate lists / track-switch rows. No SaaS sidebar card stack. No Stage above
Pool/Ship (that forced scroll past empty stage before the task).

Local URL: `http://localhost:4321/HoBo/examples/` (not `/examples/` — Astro `base` is `/HoBo`).

Agent-browser feature: `pnpm --filter hobo-site run examples:regression`
(`features/examples-console-cloudflare-station.feature` — Pool stamps a **live**
Cloudflare Temporary Accounts Environment Station via same-origin
`/api/cf-temp`, then Playwright navigates to real `*.workers.dev`). No mock
broker success path.

Honesty:
- Pool Code = synthesized `station({ yards: [provider, …] })` for
  `stationPlan.provision` (`examples/try-site/station.deploy.ts` path label).
  Yard files under `examples/try-site/yards/*.deploy.ts` are minimal provider
  default re-exports; capabilities live in provider plugins.
- Ship Bindle source = catalog `app.ts`.
- Live never shows source — Preview iframe ↔ Logs terminal only.
- Yard surfaces are operator station bootstrap only — no `waspApp` / `cli` / Bindle packaging.
- Selecting Cloudflare widens the station resource pool; Deploy stations uses
  same-origin Temporary Accounts (`/api/cf-temp`). OpenSaaS Kit ships via
  `POST /api/cf-temp/opensaas` → real `examples/wasp-opensaas` client +
  `wrangler deploy --temporary`. Swaghaus ships via `POST /api/cf-temp/swaghaus`
  → `convex deploy` + vite in `examples/convex-swaghaus` (mock with
  `HOBO_CONVEX_SWAGHAUS_MOCK=1`). Never `blob:` / never permanent API tokens /
  never invent `hobo/convex-*` images.
  Playwright: `examples:regression` (station) + `examples:regression:opensaas` (ship).
- Lakebed: `/api/lakebed-temp` (`HOBO_LAKEBED_TEMP_MOCK=1` for CI).
- Vercel: `/api/vercel-temp` via [Vercel Drop](https://vercel.com/docs/drop)
  (`HOBO_VERCEL_DROP_MOCK=1` for CI; live = session/`vercel login`, never
  permanent `VERCEL_TOKEN`).
- Netlify: `/api/provider-temp/netlify` via `netlify deploy --allow-anonymous`
  (`HOBO_NETLIFY_TEMP_MOCK=1` for CI; never `NETLIFY_AUTH_TOKEN`). Clients
  refuse HTML 404 from stale/static sites (`apiVersion: hobo-temp-v2`).
- browser-wasm / webernetes: `/api/provider-temp/:id` → navigable
  same-origin `/api/anon/host/*` stations.
- Railway not in OOB yards (no anon/temp API). Matching-honest packs in
  `target-capability-packs.ts`. Playwright: `examples:regression:anon`.
- Cloudflare native ports = compute/kv/objectStore (Workers/KV/R2) — Matching
  truth, not container fiction.
- hello-world = minimal `b.web()` + `export const runtime` + `handlers.mjs` greet on browser WIT.
- todo-api = `@trainable` Todos + `b.web(Todos).dependsOn(kv)` (kv-backed guest; no handlers.mjs).
- OpenSaaS = `b.web(waspApp(root))` + Postgres OCI; Swaghaus = `b.web(convexApp(root))` + `b.data()` + WorkOS `b.external`.
- OpenSaaS app ship may use an optional local bridge for Compose/provider CLIs; Stations themselves do not.
- Browser controller must not import Node `fs` (yard deploy sources load via `examples/yards-deploy.json`).
