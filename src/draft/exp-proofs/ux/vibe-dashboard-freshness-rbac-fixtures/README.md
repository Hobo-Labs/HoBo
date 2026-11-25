# Vibe Dashboard Freshness/RBAC Fixtures

This proof package satisfies HOBO-545 with deterministic dashboard read-state fixtures for Deployment Dashboard & Topology Explorer consumers. It stays inside `src/draft/exp-proofs/ux/vibe-dashboard-freshness-rbac-fixtures` and does not implement production dashboard UI, live projections, authorization engines, redaction engines, read stores, live support tooling, or launch claims.

## Proof

- `src/vibe-dashboard-freshness-rbac-fixtures.ts` parses the reference fixture bundle and exposes dashboard summaries plus redacted support handoff packets.
- `test/vibe-dashboard-freshness-rbac-fixtures.test.ts` proves the accepted states: fresh, stale, unavailable, redacted, unauthorized, partial, and support-routed.
- `architecture/proto/vibe_dashboard_freshness_rbac_fixtures.proto` defines the boundary messages first.
- `architecture/vibe_dashboard_freshness_rbac_fixtures.cue` pins tenant-first scoping, view-backed projection names, customer-safe wording, proof mode, coverage paths, accessibility notes, and redaction evidence.
- `architecture/pacts/vibe_dashboard_freshness_rbac_fixtures.pact.json` gives dashboard consumers a Pact-style reference response without importing production runtime code.

Run the focused proof:

```bash
pnpm --dir src/draft/exp-proofs/ux/vibe-dashboard-freshness-rbac-fixtures test
```

## Design Alignment

- PLAN-32 / Deployment Dashboard & Topology Explorer: fixture states describe projection freshness, tenant/RBAC scope, safe customer wording, and support owner routing.
- ADR-0050: read-state fixtures are projection-shaped and event-friendly without adding a read-store runtime.
- ADR-0077: tenant-first scope and RBAC role fields are parsed into the fixture object before consumers render them.
- HOBO-545 acceptance: `coveragePaths`, `accessibilityNotes`, and `proofModeLabels` explicitly cover happy, blocked, stale/unknown evidence, support handoff, accessibility, and proof-mode labels.

## Scope Guards

`classifyDashboardFixtureScope` rejects:

- authorization engine work,
- redaction runtime work,
- projection/read-store runtime work,
- live support tooling,
- production dashboard UI,
- launch or marketing claims.

These guards cover the adversarial cases in HOBO-545 while preserving the branch-sized reference-fixture scope.
