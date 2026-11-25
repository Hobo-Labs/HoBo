---
type: Reference
title: "Vibe Dashboard Freshness RBAC Fixtures Proof"
description: "Source issue: HOBO-545."
tags: [hobo, design]
---

# HOBO-545 Vibe Dashboard Freshness/RBAC Fixtures

HOBO-545 adds a branch-local proof package at `src/draft/exp-proofs/ux/vibe-dashboard-freshness-rbac-fixtures`. The package gives Deployment Dashboard & Topology Explorer consumers deterministic reference fixtures for projection freshness, tenant/RBAC scope, redaction-safe rendering, and support handoff wording.

## Acceptance Evidence

- Accepted states: fresh, stale, unavailable, redacted, unauthorized, partial, support-routed.
- Boundary shape: protobuf message definitions in `architecture/proto/vibe_dashboard_freshness_rbac_fixtures.proto`.
- Constraints: CUE keeps projection sources view-backed, tenant-first scope mandatory, support owner actor present, customer wording safe, and `proofMode` fixed to `reference fixture`.
- Coverage paths: happy path, blocked path, stale/unknown evidence, and support handoff are mapped to fixture ids with safe outcomes.
- Accessibility notes: fixtures carry screen-reader, color-independent status, and keyboard-visible support handoff guidance.
- Proof-mode labels: `live`, `simulated`, `reference fixture`, and `scope-out` are named explicitly; current read-state fixtures remain `reference fixture` evidence.
- Pact-style consumer proof: `architecture/pacts/vibe_dashboard_freshness_rbac_fixtures.pact.json` returns the parsed fixture body.
- Adversarial guard: `classifyDashboardFixtureScope` rejects authorization engine, redaction runtime, read-store runtime, live support tooling, production UI, and launch-claim creep.

## Verification

```bash
pnpm --dir src/draft/exp-proofs/ux/vibe-dashboard-freshness-rbac-fixtures test
```

## Scope Boundary

This proof intentionally does not ship production dashboard UI, live provider calls, read-store implementation, GraphQL/subscription runtime, tenant auth/RBAC engine, redaction engine, support ticket/SLA automation, or launch copy. It records safe fixtures that downstream dashboard, docs, support, and quickstart proofs can consume.
