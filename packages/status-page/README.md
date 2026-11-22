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
  A signal dated after `evaluatedAt` is also delayed until the clock reaches it.
  The freshness budget must be a nonnegative safe integer in milliseconds.
- Maintenance updates received before their schedule are held in the projection
  until the schedule arrives. Completed and canceled are terminal states. Rebuild
  older projection snapshots from the event log to recover updates discarded by
  earlier versions.
- Incidents first seen in an update or resolution keep their lifecycle monotonic
  while a late first open supplies the impact and any later state. Rebuild older
  projection snapshots from the event log to recover data earlier versions did
  not backfill.
- Older measurements contribute to history but do not replace the latest
  component label or status. Malformed optional component labels cause the
  measurement to be ignored.
- **Render** (`src/render.ts`): pure HTML string renderer, HoBo Rubberhose
  chrome, strict inline CSP, and `escapeHtml` on every value. The implemented
  `src/tokens.ts` palette must match the independent reviewed
  `scripts/visual-token-contract.json`; root `pnpm run design:lint` checks its
  contrast, and `test/status-page-design-lint.test.ts` rejects rendered palette
  drift from that contract.
- **Statuspage-v2 JSON** (`src/statuspage-json.ts`): emits the de-facto
  standard `/api/v2/summary.json` shape used by githubstatus.com and
  status.claude.com, so existing ecosystem tooling can consume HoBo pages.
- **Publish gate** (`src/redaction.ts`): public pages require a
  declared-public component allowlist; a denylist scan runs over the
  *rendered output* (every rule linear on runs of every character class and
  pair of them; the credential-in-URL and email rules report exactly the
  matches the backtracking forms did, and the internal-hostname rule those and
  more, a hostname after `_`, so the gate refuses every page it refused); the
  exact bytes are content-hashed onto the
  `statuspage.Published` audit event.
- **Static site writer** (`src/site.ts`): the only IO module — writes
  `index.html` + `api/v2/*.json` per page plus a portfolio directory.

## Design requirements

The replacement design authority is `scripts/visual-token-contract.json` and
`scripts/check-visual-tokens.mts`, run by root `pnpm run design:lint`. The
following rendered requirements live beside the implementation and have focused
enforcement; no retired `DESIGN.md` is needed.

- **Reviewed palette and contrast.** `STATUS_PAGE_TOKENS` must exactly match
  the contract, meet its contrast pairs, and exclude the forbidden SaaS palette.
  Enforced by `test/status-page-design-lint.test.ts` → `"uses exactly the
  palette approved by the independent token contract"` and `"bans the forbidden
  SaaS/Catppuccin palette"`, plus the repository-wide contrast checker.
- **Rubberhose structure.** Use Chewy display type, system-ui body text,
  ui-monospace code, day/night inversion, thick ink outlines, and hard
  zero-blur sticker shadows on cards/pressables only. Lamps, component bands,
  and uptime cells stay flat. Enforced by `"ships the Rubberhose typography
  stack"`, `"ships day/night inversion"`, `"uses thick ink outlines, never 1px
  hairlines"`, `"uses hard sticker shadows, never soft rgba elevation"`, and
  `"keeps inert status chrome flat (pressable = raised law)"` in that file.
- **Fail-safe delayed/unknown state.** Missing or stale signals render
  `Delayed / unknown` with `--faint`, never `--go` or stale attainment.
  Enforced by `test/model.test.ts` → `"forces stale components to unknown —
  never stale operational"`, `"renders declared components with no signals as
  unknown"`, and `"renders an empty scope as unknown, not an empty green page"`;
  `test/status-page-design-lint.test.ts` → `"renders delayed and unknown status
  in faint gray, never green"`.
- **Status semantics and bounded history.** Operational days use `go`,
  degraded/outage days use `spark`, and unknown/maintenance days use
  `border-strong`. History is bounded to 90 cells, every cell has a `title`,
  and the row has a day-count/component `aria-label`. Enforced by
  `test/status-page-design-lint.test.ts` → `"maps uptime cells to go, spark,
  and border-strong status tokens"` and `test/render.test.ts` → `"bounds history
  to 90 titled cells with a row label"`.
- **Mandatory output escaping.** Every interpolated value passes through
  `escapeHtml`, including all five HTML metacharacters. Enforced by
  `test/render.test.ts` → `"escapes hostile incident text (no markup
  injection)"` and `"escapeHtml covers the five metacharacters"`.
- **Reduced motion.** `prefers-reduced-motion: reduce` removes transition and
  animation timing/delays, press transforms, heading rotation, and film grain
  without removing status text. Enforced by
  `test/status-page-design-lint.test.ts` → `"disables motion and film grain
  under prefers-reduced-motion"`.
- **Accessible focus and announcements.** Focus rings are 3px `spark` with a
  3px offset; sections are labelled by headings and the banner is a
  `role="status"` live region. Enforced by
  `test/status-page-design-lint.test.ts` → `"uses 3px spark focus rings with 3px
  offsets"` and `"labels sections by headings and announces the banner as
  status"`.

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

Hosting the page as a Station sidecar (`kind: "sidecar"`,
`provenance: "default"` — present unless observed absent) is the composing
host's job; this package projects and renders.

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
- Site writer validates all slugs before touching the filesystem, including
  traversal and duplicate checks. Later filesystem failures can leave partial
  output and require a retry or cleanup.

## Honest scope

The projection folds events in-process; there is no hosted publisher or
subscriber management here (HOBO-497 exclusions still hold). AvailabilityView
(ADR-0078) stays internal-only and is intentionally **not** rendered on any
public page.
