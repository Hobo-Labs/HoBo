# `src/ocm/` — Open Cluster Management realizer

`ocmRealizer(deps): Realizer` delivers a Camp's Set as **one ManifestWork**
named `hobo-<camp>-<setdigest8>` in the hub's cluster namespace
(`work.open-cluster-management.io/v1`). It never creates a
ManifestWorkReplicaSet and never reads an OCM Placement: HoBo's fan-out
schedules ordinary per-Camp promotions, so N Camps are N single-cluster works.

| File | Holds |
|---|---|
| `manifest-work.ts` | `renderManifestWork` (manifests, `manifestConfigs` feedback rules, `deleteOption`), `parseWorkStatus`. |
| `realizer.ts` | `ocmRealizer`, `evaluateWork` (pure verdict), `supersededDeleteOption`. |

- **Feedback rules** come from `observe_fields` (via the injected
  `observeFields(campId)` reader, normally `PostureService.observeFields`):
  `WellKnownStatus` for workloads, `JSONPaths` for `status.*` fields.
- **`deleteOption`** follows the `DepartureAction`: `DELETE` → `Foreground`,
  `ORPHAN` → `Orphan`, `ORPHAN_DATA` → `SelectivelyOrphan` with one orphaning
  rule per data object (PVCs, classified or data-port resources); the
  reconciler's `keep` directive always orphans.
- **Convergence** needs the work's `Applied` and `Available` conditions `True`
  at the current generation, every desired manifest `Applied`/`Available`,
  workload feedback ready, the hub's manifests byte-equal to the Set, and no
  superseded work left.
- **Make before break**: the superseded work is deleted only after the new one
  converges; its `deleteOption` is rewritten first.

## Runbook

| Symptom | Action |
|---|---|
| `ocm-work-not-applied` for long | `kubectl get managedcluster <cluster>`: joined and available? `kubectl -n <cluster> get manifestwork hobo-<camp>-*`: does the status move? Check the klusterlet work agent logs. |
| `ocm-work-apply-failed` | The reason message carries the agent's condition message (e.g. an admission denial). Fix the declaration and promote again. |
| `ocm-work-modified` | The work was edited on the hub. Converge re-applies the Set; to change it, change the declaration. |
| Two works for one Camp for long | `ocm-superseded-work-pending`: the old work is terminating. If it never goes, check its finalizers on the hub. |
