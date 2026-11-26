---
type: Runbook
title: "HoBo.CD runbook: Reconcilers and drift"
description: "Leases, convergence, realizers and drift. Assembled from the Runbook section of packages/cd/src/reconcile/README.md."
tags: [hobo, cd, runbook, reconcile]
---

# HoBo.CD runbook: Reconcilers and drift

Leases, convergence, realizers and drift. This page is assembled from the **Runbook** section of `packages/cd/src/reconcile/README.md`,
which stays the source of truth; update that section and re-assemble. The
symptom index is [index.md](./index.md); the design is
[continuous-delivery.md](../../design/continuous-delivery.md).

## Procedures

| Symptom | Reason code | Action |
|---|---|---|
| Camp never converges; `lease_refused` climbs | `lease-held` | Another reconciler holds `cd:camp:<id>`. Find it in `cd-camp-status-<id>` (`reconcilerId`). Revoke it (the governed `reconciler.revoke` action) or wait one lease TTL (30 s). Never run two writers. |
| Reports refused after a failover of the conductor | `stale-fence` | Expected for the old process: it lost the lease and stopped before mutating. Stop the old process. |
| `ReconcileBlocked` right after a promotion | `resolved-set-missing` / `resolved-set-mismatch` | The resolved-set blob is missing or corrupt in the artifact store. Restore it (or re-apply the Set); the reconciler retries the same change. |
| `ReconcileBlocked` with `realize-failed` | `realize-failed` | Provider or credential failure. Fix it; the next pass resumes by observation (idempotent). To undo instead, roll back (a Delta through the gate). |
| `attestation-refused` | `attestation-refused` | The apply worker's host attestor keys or code digest do not verify. Fix the attestor configuration; nothing was applied. |
| `drift.DiffProposed` events | `drift-proposed` | Review the diff; approve a `drift-remediate` Delta or adopt the change in the declaration. |
| `ReconcileBlocked` with `drift-escalated` | `drift-escalated` | Drift oscillated, exceeded the blast radius, or deleted a data resource. Investigate before re-applying; restore data from backup if needed. |
| Many `attribute-truncated` / `attribute-dropped` | as named | The bound posture packs request too much; narrow `observe_fields`. |
| `departure-keep-violated` | `departure-keep-violated` | A realizer deleted a kept resource. Restore it from backup and fix the realizer to honour `keep`. |
| Camp shows `OBSERVED`, never converges | `observe-only` | The Camp is `OBSERVE_ONLY`. Promote it with `camp.manage` when adoption is complete. |
| `store-unavailable` / `lease-unsupported` | as named | The journal is down, or the store has no subscription leases. Run on `@hobo/storage-sqlite` / `@hobo/storage-postgres`. |
