# `@hobo/cd-kube-fleet` data models

| File | Contents |
|---|---|
| `kube_fleet.proto` | `KubeHubRecord` (`hobo.cd-kube-fleet.hub/v1`), `CampClusterRecord`, `OcmRealizerRecord` (`hobo.cd-kube-fleet.ocm/v1`), `KarmadaRealizerRecord` (`hobo.cd-kube-fleet.karmada/v1`), `ClusterProfileImportRecord` (`hobo.cd-kube-fleet.cluster-profiles/v1`), `KubeObjectRefRecord`, `ImportedClusterRecord`; enums `HubKind`, `KubeAuth`. Generated into `src/_generated/kube_fleet_pb.ts` by `pnpm run codegen`. |
| `kube_fleet.cue` | Constraints for every message: https-only API base URLs with no path or credentials, non-empty credential references, DNS-1123 cluster and namespace names, known `DepartureAction` names, declared regions, bounded timeouts. `test/config.test.ts` keeps the parsers and CUE in agreement. |
| `buf.yaml` | Opts the package into codegen. |

Records hold credential **references**, never secret values. Kubernetes
object shapes (ManifestWork, PropagationPolicy, ResourceBinding,
ClusterProfile) are external API types read through the parse boundary, not
HoBo records.

## Runbook

| Symptom | Action |
|---|---|
| `codegen:check` drift | Run `pnpm run codegen --filter packages/cd-kube-fleet` and commit `src/_generated/`. |
| CUE agreement test fails | A parser rule and `kube_fleet.cue` diverged; change both together. |
