---
type: Runbook
title: "HoBo.CD runbook: Placement"
description: "Placement decisions and score snapshots. Assembled from the Runbook section of packages/cd/src/placement/README.md."
tags: [hobo, cd, runbook, placement]
---

# HoBo.CD runbook: Placement

Placement decisions and score snapshots. This page is assembled from the **Runbook** section of `packages/cd/src/placement/README.md`,
which stays the source of truth; update that section and re-assemble. The
symptom index is [index.md](./index.md); the design is
[continuous-delivery.md](../../design/continuous-delivery.md).

## Procedures

- **`placement-unsatisfiable`.** Read `subject`: a spread key means the
  eligible Camps cover too few distinct values; `count` means too few eligible
  Camps; `candidates` means none. Inspect the inventory (`hobo` CLI / control
  API `inventory list`) for taints and the Rail's bound Camp sets.
- **A Camp you expected is not selected.** Its candidate row lists the
  exclusion codes. `taint-not-tolerated`: see the inventory runbook.
  `residency-conflict:*`: its declared Yard regions are outside the subject's
  allowed jurisdictions; claims cannot change that.
- **Decision differs between replicas.** It cannot for the same recorded
  inputs; compare `inventoryDigest` and `scoreSnapshotDigests`. Differing
  digests mean the inventory or scores changed between the calls.
- **`rail-providers-unknown` on every decision.** Wire
  `approvedProviders: (stationId) => rail.approvedProviders` into
  `createPlacementEngine` in the composition.
