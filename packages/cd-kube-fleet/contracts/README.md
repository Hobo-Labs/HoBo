# `contracts/` — hub boundaries (PACT)

| Pact | Consumer → provider | Pins |
|---|---|---|
| `pacts/cd_kube_fleet_ocm.pact.json` | `HoboCdKubeFleetOcmRealizer` → `OpenClusterManagementHub` | First converge (list, create one single-cluster ManifestWork with feedback rules and deleteOption); recorded work statuses for converged, apply-failed and not-yet-reported. |
| `pacts/cd_kube_fleet_karmada.pact.json` | `HoboCdKubeFleetKarmadaRealizer` → `KarmadaControlPlane` | First converge (policy pinned to one member before the template); recorded ResourceBindings applied and Healthy on the member, and bound to a second member (pinning violation). |
| `pacts/cd_kube_fleet_cluster_profiles.pact.json` | `HoboCdKubeFleetClusterProfileInventory` → `ClusterInventoryApiServer` | A recorded ClusterProfile list (two valid, one invalid). |

`consumer/hubs.consumer.test.ts` replays each pact strictly in order through
`consumer/pact-transport.ts` and asserts method, path, query, header subset
and body subset of every request the package sends, then checks how the
recorded responses are interpreted. Response bodies follow the upstream API
references (OCM `work/v1`, Karmada `policy/v1alpha1` + `work/v1alpha2`,
`multicluster.x-k8s.io/v1alpha1`), including server-populated fields
(`uid`, `resourceVersion`, defaulted template fields) the realizers must
tolerate. The live `kind` lane (`test/kind-lane.test.ts`) is the provider
verification against real hubs.

## Runbook

| Symptom | Action |
|---|---|
| A consumer test fails on a request mismatch | The package changed what it sends. If intended, update the pact interaction and say why in the commit; the provider (hub API) must still accept it. |
| A hub upgrade changes a status shape | Record the new response into the pact, then fix the parser in `src/ocm/manifest-work.ts`, `src/karmada/policy.ts` or `src/cluster-profile/parse.ts`. |
