---
type: Design Proof Evidence
title: "HOBO-561 Vibe Topology/Status Prototype Proof"
description: "M2 proof record for topology/status reference prototype over projection snapshots."
tags: [hobo, proof, dashboard, topology, status, vibe]
timestamp: 2026-07-01T00:00:00Z
---

# HOBO-561 Vibe Topology/Status Prototype Proof

This proof records branch evidence for a topology/status reference prototype
over accepted projection snapshots.

## Evidence

- Dashboard mockup source: [`vibe-deployment-dashboard-mockups`](../vibe-deployment-dashboard-mockups/README.md).
- Freshness/RBAC fixture source: [`vibe-dashboard-freshness-rbac-fixtures`](../vibe-dashboard-freshness-rbac-fixtures/README.md).
- Quickstart fixture source: [`resource-lifecycle-quickstart-examples`](../resource-lifecycle-quickstart-examples/README.md).
- Source record: [`deployment-dashboard-topology-explorer.md`](../../deployment-dashboard-topology-explorer.md).
- Executable proof: [`vibe-topology-status-prototype`](../../../../src/draft/exp-proofs/ux/vibe-topology-status-prototype/README.md).

## Acceptance Coverage

| Acceptance | Proof |
|---|---|
| Prototype consumes M1 dashboard mockups and freshness/RBAC/support fixtures. | Tests assert accepted HOBO-544 and HOBO-545 dependencies through parsed proof exports. |
| Prototype reuses accepted resource-lifecycle quickstart behavior. | `quickstartFixtureRefs` pins HOBO-577 fixture ids, proof-mode labels, and consuming topology/status surfaces. |
| Projection snapshots include fresh, stale, unavailable, redacted, unauthorized, partial, failed, rolled back, and completed states. | `VIBE_TOPOLOGY_STATUS_PROTOTYPE.snapshots` is parsed against the required state list. |
| Package and proof path match the issue. | Parser rejects target package or proof path drift. |
| Happy path, blocked path, stale/unknown evidence path, support handoff, accessibility notes, and proof-mode labels are covered. | Scenario tests require every state and proof mode to be represented. |

## Adversarial Evidence

The classifier rejects production dashboard/frontend work, graph renderer work,
projection runtime or GraphQL facade work, tenant RBAC implementation, live
provider traversal, and launch-readiness claims.

## Verification

```powershell
pnpm.cmd --dir src\draft\exp-proofs\vibe-topology-status-prototype test
```
