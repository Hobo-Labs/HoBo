# Control-Plane Yard (UX experience proof)

Game-first control plane for HoBo Stations — not a multi-page admin SPA.

## Parse, don't validate

`controlYardAcceptance()` is the **parse, don't validate** boundary for this proof:
acceptance criteria become frozen **derived types** (`ControlYardAcceptance`).
Tests assert required zones and art-bible invariants without re-checking free-form JSON.

## Event architecture

- **Command** — experience proof documents zone → sheet → management confirm path.
- **Events** — Station/Connection families only (via production packages).
- **Actor** — YardEngine (production) is the visual actor.
- **Event store** — `HOBO_HOME` via `@hobo/management`.
- **Materialized view / projection** — yard snapshot projection.
- **Snapshot** — `YardProjectionSnapshot` / acceptance record.
- **Read store** — control-api SSE + proof fixtures.

## Evidence (required)

Interactive claims need Playwright **screenshots + MP4s**. Self-report is rejected.

```bash
pnpm --filter @hobo/control-yard run evidence
pnpm --filter @hobo/control-yard run evidence:check
```

Synced into this proof at `assets/evidence/` (PNGs + `recordings/*.mp4` +
`evidence-manifest.json`). See `AGENTS.md`.

## How to run locally

```bash
# Package tests (management + API + yard engine)
pnpm --filter @hobo/management test
pnpm --filter @hobo/control-api test
pnpm --filter @hobo/control-yard test

# This proof package
pnpm exec turbo run test --filter ./src/draft/exp-proofs/ux/control-yard
```

## Zones

See [assets/yard-zones.svg](./assets/yard-zones.svg) for the v0 single-Station layout.

| Zone | Projection |
|---|---|
| Platform Rest | idle / station down |
| Bootstrap Desk | `bootstrapActive` |
| Active Rail Track | `activeRailHash` + traffic |
| Connection Bay | connections by status |
| Policy Board | rails lifecycle |
| Cost Booth | rail `billingPolicy` |
| Error Bunker | doctor hazards |

## Acceptance

- Management ops shared with CLI
- Control API HTTP+SSE from fixtures
- Bo idle + walk east/west at measured frames; west not mirrored
- OpenUI-style connection sheet confirms through management path
- Asset index is sole clip metadata source
