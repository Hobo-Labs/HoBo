# `test/` — @hobo/cd-kube-fleet

| File | Covers |
|---|---|
| `realizer-conformance.ts` + `.test.ts` | The `Realizer` port properties for both realizers (never converged without observation, idempotent, observe never mutates, stale fence, abort, I1 mismatch, unmapped Camp, Secret refusal, outage, auth failure, secret-free records and metrics). WP20 adds both realizers to the shared `@hobo/conformance` suite at merge. |
| `ocm.test.ts` | §10 row "HoBo fan-out over OCM-backed Camps" (N single-cluster ManifestWorks, never a ManifestWorkReplicaSet), naming, feedback rules from `observe_fields`, `deleteOption` per `DepartureAction`, make-before-break, `keep`, apply failure, readiness, drift, fence re-stamp. |
| `karmada.test.ts` | Pinned to exactly one cluster, pinning violations, template conflicts, cluster-scoped refusal, departure preserve semantics, health, attributes, stale bindings. |
| `cluster-profile.test.ts` | ClusterProfile import yields `OBSERVE_ONLY` Camps posture can evaluate; claims, conditions, publish, host-side credentials never recorded, paging, watch with bookmarks and 410 re-list. |
| `config.test.ts` | Parse boundary and `kube_fleet.cue` agreement. |
| `kube.test.ts` | API client (credentials, status mapping, watch parsing) and plan resource rendering. |
| `architecture.test.ts` | I11 scan (no Kubernetes type in `@hobo/cd`), dependencies, no client library, no forbidden fleet-manager resources, public surface. |
| `kind-lane.test.ts` | Live lane against kind-hosted hubs; skips naming the missing variables. |
| `fake-hub.ts` | In-memory Kubernetes API server with simulated OCM work agent and Karmada binding controller. |
| `fixtures.ts`, `fixtures/` | Resolved sets, inputs, configs, a recorded ClusterProfile list. |

## Runbook

| Symptom | Action |
|---|---|
| CUE tests skipped | No `cue` binary: run `scripts/bootstrap-dev.sh` (installs the pinned CUE under `.tools/`). |
| kind lane skipped | Expected without hubs; see the package README "Live kind lane". |
