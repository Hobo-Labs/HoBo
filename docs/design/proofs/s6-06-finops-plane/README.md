---
type: Reference
title: "S6-06 FinOps plane proof"
description: "Proof record for HOBO-661 FinOps plane draft POC: plan estimates, budget gates, showback."
tags: [hobo, finops, proof, s6]
---

# S6-06 FinOps plane proof (HOBO-661)

Source issue: [HOBO-661](https://linear.app/quickdeploy-ai/issue/HOBO-661)

Executable proof:
[`src/draft/projects/s6-06-finops-plane`](../../../../src/draft/projects/s6-06-finops-plane/README.md)

Design references:

- [Plan 05 — Cost & FinOps](../../reliability-observability-cost.md#plan-05)
- [FinOps budget routing control plane](../../finops-budget-routing-control-plane.md)

## Acceptance mapping

| Acceptance | Evidence |
|---|---|
| `hobo plan` projected cost from `cost.json` within ±20% (NFR-012 / FR-070) | `estimatePlanCost` + `withinCostTolerance` in acceptance test, including fail-closed `cost.json.regions` coverage |
| Budget breach blocks deploy | `evaluateFinOpsDeployGate` hard-limit deny path, including current MeteringView spend + next estimate projection |
| Showback reconciles against recorded spend | `reconcileShowbackProjection` matches MeteringView total |

Run:

```bash
pnpm --prefix src/draft/projects/s6-06-finops-plane test
```

Architecture evidence: `architecture/finops_plane.proto`, `architecture/finops_plane.cue`,
`architecture.md`, and `contracts/pacts/finops_plane_boundary.pact.json`.
