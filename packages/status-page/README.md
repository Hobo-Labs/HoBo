# @hobo/status-page

Event-sourced status pages for every HoBo scope — the ADR-0077 / Plan 49 §C
surface. Every deployment already carries OTel observability; this package
turns those signals into a githubstatus.com-style page **out of the box**:

- **Station slice** — HoBo control-plane capability surfaces on one Station
  (dashboard, evidence, otlp, evals, … sidecars).
- **Primitives slice** — the closed Bindle-primitive vocabulary (`web`,
  `api`, `kv`, …) imported from `@hobo/capability-profiles`.
- **Project / Bindle slices** — the user-centric views. Every Bindle gets a
  page by default (an app in the app portfolio); Projects group their
  Bindles plus configured service dependencies (`b.external(...)`,
  `b.container(...)`).

## Architecture

Event-driven CQRS end to end (ADR-0086-safe). In the mandated vocabulary:
publish requests are the **command** side (`publishStatusPage` produces the
`statuspage.Published` fact an operator **actor** appends to the
**event store**); the status-page projection is the **materialized view**
folded from the log; a `ProjectionSnapshot` is a cache only — the rendered
static site is the **read store**, rebuildable from zero. Types follow
*parse, don't validate*: parse functions return frozen **derived types**
(`parseStatusScope`, `parseIncidentRecord`, …) whose wire forms live in
`data-models/status_page.proto` + `.cue`.

- **Read-set** (`src/events.ts`): `slo.Measured`, `incident.Opened/Updated/
  Resolved`, `maintenance.Scheduled/Updated`, plus the statuspage family's
  own audit events — `statuspage.Published`, `statuspage.Unpublished`,
  `statuspage.IncidentPosted` (the Plan 49 event budget; grouping and
  availability add no event types).
- **Projection** (`src/projection.ts`): a pure `defineProjection` fold from
  `@hobo/data`, keyed `project:<id>` / `tenant:<id>` / explicit
  `data.scopeKey`. No clocks, no randomness, no IO; replay-safe.
- **Evaluation** (`src/model.ts`): wall-clock enters exactly once, as an
  explicit `evaluatedAt`. Components without a signal inside the freshness
  budget render **delayed/unknown — never stale operational** (ADR-0077 §4).
- **Render** (`src/render.ts`): pure HTML string renderer, HoBo Rubberhose
  chrome (see `DESIGN.md`), strict inline CSP, `escapeHtml` on every value.
- **Statuspage-v2 JSON** (`src/statuspage-json.ts`): emits the de-facto
  standard `/api/v2/summary.json` shape used by githubstatus.com and
  status.claude.com, so existing ecosystem tooling can consume HoBo pages.
- **Publish gate** (`src/redaction.ts`): public pages require a
  declared-public component allowlist; a denylist scan runs over the
  *rendered output*; the exact bytes are content-hashed onto the
  `statuspage.Published` audit event.
- **Static site writer** (`src/site.ts`): the only IO module — writes
  `index.html` + `api/v2/*.json` per page plus a portfolio directory.

## Default-on with opt-out (ADR-0145)

The Bindle trait is **read-side default-on**: `deriveBindleStatusPlan`
produces a plan for every Bindle with no annotation required (so canonical
manifests and plan hashes stay stable). Configure or opt out per resource:

```ts
import { bindle, statusPage } from "@hobo/bindles";

const app = bindle("shop", (b) => ({
	web: b.web().with(statusPage({ project: "storefront" })),
	worker: b.job().with(statusPage({ enabled: false })), // excluded component
	db: b.external({ endpoints: { http: "https://db.example.com" } }),
}));
```

Station-side, the status page is a default sidecar (`kind: "sidecar"`,
`provenance: "default"` — present unless observed absent) served by
`@hobo/code`'s occupancy fleet; `HOBO_CODE_SIDECARS=0` disables the fleet.

## Edge cases handled (and tested)

- `incident.Resolved` before `incident.Opened` → resolved tombstone; the
  late open backfills fields but never reopens.
- Duplicate `incident.Opened` → idempotent; lifecycle regressions ignored.
- Late `slo.Measured` samples never overwrite newer status; attainment is
  clamped to [0,1]; malformed payloads leave the row unchanged.
- Uptime history is bounded to 90 UTC days per component.
- Empty scope → honest "delayed/unknown" page, not an empty green page.
- Incidents referencing unregistered components still render.
- Public publishes recompute the banner from public components only, and
  refuse an empty allowlist.
- Site writer rejects slug traversal and duplicate slugs.

## Honest scope

The projection folds events in-process; there is no hosted publisher or
subscriber management here (HOBO-497 exclusions still hold). AvailabilityView
(ADR-0078) stays internal-only and is intentionally **not** rendered on any
public page.
