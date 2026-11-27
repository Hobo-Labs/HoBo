# @hobo/cd-argocd

Argo CD control-plane adapter for HoBo CD: observe Application status, trigger
sync, and run `hobo.cd.argocd-sync/v1` RUNBOOK hooks (Kargo `argocd-update` parity).

Consumer PACT: `contracts/pacts/cd_argocd_control.pact.json`.

Register at compose time with `cdArgocdEngineRegistration` and wrap runbook
execution with `createArgoCdRunbookExecutor`.

The client validates and snapshots its HTTPS endpoint and credential reference.
A successful RUNBOOK returns `syncRequested: true` when Argo CD accepts the
request; use `observeSync` to check convergence and health.

## Architecture

- **Parse, don't validate.** Configuration crosses `parseArgocdControlConfig`
  into the derived type `ArgocdControlConfig`, constrained by `argocd.cue`.
- **Commands, events, actors.** This package is a stateless adapter. The
  `CampReconciler` actor in publisher mode issues publish commands; the promotion
  saga may issue RUNBOOK hooks that call `requestSync`. Facts append to the
  durable **event store**; fleet **projections** (materialized views in the read
  store) carry reconcile status; reconciler **snapshots** checkpoint progress.
- **ClusterSyncPort** is the neutral `@hobo/cd` boundary; Argo CD vocabulary
  stays in this package (I11).