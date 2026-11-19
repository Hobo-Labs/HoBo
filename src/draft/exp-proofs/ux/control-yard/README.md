# Control-Plane Yard (UX experience proof)

Game-first control plane for HoBo Stations — not a multi-page admin SPA.

## Proof record

`controlYardAcceptance()` returns a static, shallow-frozen record naming zones,
packages, the art bible, the management path, and two flags. Its tests check
some record fields and the zone names in the SVG. They do not parse the criteria
in `proof.json` or establish the full behavior those criteria describe.

The `ControlYardZone` derived type comes from `REQUIRED_ZONES`.
`assertYardZones()` checks that a string list includes those names; it does not
parse the criteria in `proof.json`. There is no parse, don't validate boundary
for those criteria.

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
`evidence-manifest.json`). The check validates both this copy and the package
copy. See `AGENTS.md`.

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

The pixel-village core-loop, browser, scenario, and experience-review gates
were removed with that package. In `proof.json`, only ACC-CORE-LOOP names an
executable gate today; the other criteria keep `gate: null` with
`evidenceStatus: unverified` and `retiredCoverage` documents why. Captured
Yard evidence and package tests provide partial signal but do not replace the
retired pixel-village gates.

- Management ops shared with CLI
- Control API HTTP+SSE from fixtures
- Bo idle + walk east/west at measured frames; west not mirrored
- OpenUI-style connection sheet confirms through management path
- Asset index is sole clip metadata source
