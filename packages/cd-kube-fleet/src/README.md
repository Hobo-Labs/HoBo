# `src/` — @hobo/cd-kube-fleet

| File / folder | Holds |
|---|---|
| `index.ts` | The public surface (realizers, inventory, parsers, records, failure and metric vocabularies). |
| `config.ts` | Parse boundary for the configuration records: `KubeHub`, `RealizerConfig`, `ClusterProfileImport` (branded, frozen). |
| `errors.ts` | `KUBE_FLEET_FAILURES` (code → remediation), `KubeFleetError`, `reason()`. |
| `json.ts` | JSON guards; the only way hub responses are read. |
| `telemetry.ts` | `KUBE_FLEET_METRICS` and the per-pass meter over `TelemetrySink`. |
| [`kube/`](kube/README.md) | Kubernetes API client over `HttpTransport`, plan resource → object rendering, shared observation builder. |
| [`ocm/`](ocm/README.md) | `ocmRealizer`: one ManifestWork per Camp. |
| [`karmada/`](karmada/README.md) | `karmadaRealizer`: templates + a PropagationPolicy pinned to one member. |
| [`cluster-profile/`](cluster-profile/README.md) | `clusterProfileInventory`: ClusterProfiles as OBSERVE_ONLY Camps. |
| `_generated/` | `kube_fleet_pb.ts`, generated from `data-models/kube_fleet.proto` by `pnpm run codegen`. Never hand-edited. |

Both realizers implement the frozen `Realizer` port from `@hobo/cd`: they are
idempotent, never report `CONVERGED` without observing the hub, refuse a
stale fence, and turn every target-side failure into a typed reason on a
`BLOCKED`/`CONVERGING` observation. Only an aborted signal rejects.

## Runbook

| Symptom | Action |
|---|---|
| A pass rejects instead of returning an observation | The lease signal was aborted (lease lost or shutdown). Expected; the next lease holder resumes by observation. |
| `kube-fleet-config-invalid` at start | Fix the configuration record; see `data-models/kube_fleet.cue` for every rule. |
| Any other reason code | See the package [README runbook](../README.md#runbook). |
