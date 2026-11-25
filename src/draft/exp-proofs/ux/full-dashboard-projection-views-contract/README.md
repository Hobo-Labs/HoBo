# Full Dashboard Projection Views Contract

HOBO-662 draft POC proving Plan 07 dashboard views render from projections only for
`examples/multi-cloud-shop`, with automated WCAG 2.1 AA and pseudo-localization gates.

## What This Proves

- All eleven Plan 07 dashboard views render from projection fixtures without privileged state.
- Deployments timeline exposes replay/time-travel scrubber semantics from `DeploymentView`.
- Topology graph annotates bind edges with connectivity tier and estimated egress cost.
- Run inspector exposes replay-diff status from `RunView`.
- Registry browser carries Forge certification and provenance digest.
- Agent activity and credential audit joins grants, uses, and policy approvals.
- Cost/FinOps, drift, plan preview, policy gate approvals, promote/rollback, and live tail render
  from fixture projections only.
- Automated WCAG 2.1 AA structural audit passes on rendered dashboard HTML.
- Pseudo-localization expands strings to 200% length and validates RTL document direction.

## Boundary

This package validates the S6-07 dashboard projection contract. It does not ship `apps/dashboard`
production UI, live Gateway streams, provider APIs, or merged S6-05/S6-06 runtime code.

## Verification

```bash
pnpm --prefix src/draft/exp-proofs/ux/full-dashboard-projection-views-contract test
```

## Architecture Evidence

- `architecture/` — protobuf data shapes and CUE constraints.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
