# `src/cluster-profile/` — ClusterProfile import

`clusterProfileInventory(deps)` reads SIG-Multicluster ClusterProfiles
(`multicluster.x-k8s.io/v1alpha1`, KEP-4322) and presents each as an
**`OBSERVE_ONLY` Camp**. A Camp is promoted to `MANAGED` only through
`CampInventory.manage` (a governed action), never by this package.

| File | Holds |
|---|---|
| `parse.ts` | `parseClusterProfile` → `ImportedCamp` (topology, conditions, claims, secret-free `ImportedClusterRecord`, posture attributes, in-memory access providers) or a skip reason. |
| `inventory.ts` | `clusterProfileInventory`: paged `list`, bounded `watch` with bookmarks and 410 re-list, `topology()` (`TopologyReader`), `publish` (`CampInventory.observe`), `observation` (posture), `access` (host-side credentials). |

Mapping:

| ClusterProfile | Camp |
|---|---|
| `<namespace>/<name>` | Camp id `<camp_id_prefix><slug(namespace-name)>` |
| import record `yard_id`, `station_id`, `provider`, `env_type`, `regions` | declared `CampTopology` (regions are **never** taken from a profile, I19) |
| `metadata.labels` | claims `label:<key>`; `topology.kubernetes.io/region`/`zone` → `region`/`zone` |
| `status.properties[]` | claims `<name>` |
| `status.version.kubernetes` | claim `kubernetes.version` |
| `status.conditions[ControlPlaneHealthy]` | condition `READY`, source `HEALTH_SOURCE` |
| `status.accessProviders[]` | provider names in the record; endpoints and credentials in memory only |

Claims are reported by `service:cluster-manager/<manager>`. Inventory
(WP22) compares them with declared topology: a contradicting claim taints the
Camp `NO_PLACE`; a claim never satisfies residency, a capability or a binding.

## Runbook

| Symptom | Action |
|---|---|
| A profile is missing from the Camps | Check the skip reasons of `list()` (`clusterprofile-invalid`, `clusterprofile-camp-collision`) and the `label_selector`. |
| Watch re-lists repeatedly | The API server compacted history (410 Gone). Harmless; lower `watch_timeout_seconds` if it is constant. |
| `clusterprofile-access-missing` | The profile has no https access provider; install an access-provider plugin. |
| Region claim contradicts the declared region | Expected protection (I19): fix the import's declared `regions` or the cluster's label; the Camp stays `NO_PLACE` until they agree. |
