# `@hobo/cd-kube-fleet`

Kubernetes fleet managers as **transports and inventory** for HoBo Camps,
never as schedulers (ADR-0182: D26, C23). An existing Open
Cluster Management hub, a Karmada control plane or any SIG-Multicluster
ClusterProfile inventory can carry HoBo deliveries to Kubernetes Camps. None is
required, and none ever places, rolls out, overrides or fails over a HoBo
delivery: HoBo's Placement, fan-out, verification and failover stay the only
brains (D8, D20–D23).

The package talks to the Kubernetes API over `HttpTransport` with no client
library and no kubeconfig. Bearer tokens (or a host-side exec plugin's
ExecCredential token) come from the `CredentialResolver` per call and travel in
the `Authorization` header only. Its public surface takes and returns
`@hobo/cd`/`@hobo/core` types; Kubernetes shapes stay inside this package, so no
Kubernetes type crosses into `@hobo/cd` (I11, `test/architecture.test.ts`).

| Export | What it is |
|---|---|
| `ocmRealizer(deps): Realizer` | One ManifestWork per Camp (`hobo-<camp>-<setdigest8>`) in the hub's cluster namespace; feedback rules from `observe_fields`; `deleteOption` from `DepartureAction`; converges only on observed `Applied`/`Available` plus HoBo verification. Never a ManifestWorkReplicaSet or an OCM Placement. |
| `karmadaRealizer(deps): Realizer` | Resource templates plus a PropagationPolicy pinned to one member (`clusterAffinity.clusterNames: [<member>]`, `Duplicated`, `conflictResolution: Abort`); observation from the ResourceBinding aggregated status. No OverridePolicy, no spread constraints, no failover. |
| `clusterProfileInventory(deps)` | Lists and watches `multicluster.x-k8s.io/v1alpha1` ClusterProfiles; each becomes an `OBSERVE_ONLY` `CampTopology` whose properties, labels and status are observed **claims** and conditions; access-provider credentials resolve host-side and are never recorded. |
| `parseOcmRealizerConfig`, `parseKarmadaRealizerConfig`, `parseClusterProfileImport`, `parseKubeHub` | The parse boundary for the configuration records in `data-models/kube_fleet.proto`. |
| `KUBE_FLEET_FAILURES`, `KubeFleetError` | Typed failure codes, each with its remediation. |
| `KUBE_FLEET_METRICS` | Metric names emitted through `TelemetrySink`. |

Source folders: [`src/`](src/README.md) (shared client, rendering,
observation), [`src/ocm/`](src/ocm/README.md),
[`src/karmada/`](src/karmada/README.md),
[`src/cluster-profile/`](src/cluster-profile/README.md),
[`src/kube/`](src/kube/README.md); records in
[`data-models/`](data-models/README.md); hub boundaries in
[`contracts/`](contracts/README.md).

## How it fits HoBo's event architecture

This adapter holds no state of its own and writes no events. Every **command**
reaches it through the Camp reconciler (WP7), the only delivery mutator (I2):
the reconciler holds the per-Camp lease and fence, reads desired state from
the **event store** (the Camp's spec stream), calls `Realizer.converge` or
`Realizer.observe`, and appends the returned `ReconcileObservationRecord` as
the Camp's status **events**. The Camp **actor** is that lease holder; there
is no second writer. The hub objects themselves are a **materialized view** of
the Set, keyed by Camp and Set digest and stamped with the writer's fence, so a
stale writer is refused (`stale-fence`). Recovery needs no **snapshot**: a
crash between apply and observe resumes by observation, because every pass
re-reads the hub (the **read store** here is the hub API) and only writes what
differs. ClusterProfile imports feed `CampInventory.observe` (WP22), whose
projection is the Camp status fold.

## Parse, don't validate

Configuration records become branded, frozen derived types in `src/config.ts`
and nowhere else (`KubeHub`, `RealizerConfig`, `ClusterProfileImport`); the CUE
constraints in `data-models/kube_fleet.cue` and the parsers agree
(`test/config.test.ts`). A plan resource becomes a parsed `KubeObject` (kind,
REST plural, namespace, name, canonical body) in `src/kube/objects.ts` or a
typed refusal; a ClusterProfile becomes an `ImportedCamp` in
`src/cluster-profile/parse.ts` or a skip reason. Hub responses are read only
through the JSON guards in `src/json.ts`.

## Decisions taken where the plan was silent (conservative)

- **One plan resource is one Kubernetes object.** A resource without a
  Kubernetes form (`realizationParameters.manifest`, or a known `productId`
  with `realizationParameters.spec`) refuses the whole Set
  (`kube-object-unrenderable`): a partial apply would converge a Camp to
  something nobody declared.
- **Secrets never travel** (`kube-secret-refused`, I9).
- **Make before break (OCM).** A new Set is a new ManifestWork; the previous
  work is deleted only after the new one is observed Applied and Available and every workload's WellKnownStatus feedback says ready (fail closed: an omitted ready count is zero, no feedback is `ocm-feedback-missing`).
  Shared ownership keeps resources both declare; the old work's
  `deleteOption` is rewritten first so removed data follows the
  `DepartureAction` and the reconciler's `keep` directive.
- **Karmada is namespaced-only.** Cluster-scoped objects are refused
  (`karmada-cluster-scoped-unsupported`); templates of two Camps may not
  share a name and namespace (`karmada-template-conflict`). Compute and data
  templates sit under separate PropagationPolicies so
  `preserveResourcesOnDeletion` follows the `DepartureAction`; a kept compute
  template under a non-preserving policy is left in place
  (`karmada-keep-retained`), never deleted.
- **Fleet-manager signals are a health source.** ClusterProfile conditions are
  recorded with `SIGNAL_SOURCE_HEALTH_SOURCE`, so they can narrow placement
  but never alone trigger `NO_RUN` or failover. Regions are declared in the
  import record, never taken from a profile (I19).
- **OCM feedback reads `status.*` only.** Other `observe_fields` are reported
  absent with `kube-attribute-unobservable` (posture treats them as unknown,
  fail closed).

## Metrics (`TelemetrySink`)

`hobo.cd.kube_fleet.api.calls{hub,verb,code}`,
`hobo.cd.kube_fleet.realize.passes{realizer,hub,camp,mode,status}`,
`hobo.cd.kube_fleet.realize.duration` (ms histogram),
`hobo.cd.kube_fleet.realize.mutations{realizer,verb}`,
`hobo.cd.kube_fleet.cluster_profiles{hub}` (gauge),
`hobo.cd.kube_fleet.cluster_profiles.skipped{hub}`,
`hobo.cd.kube_fleet.watch.relists{hub}`. Telemetry failures never fail a pass.

## Runbook

| Symptom | Reason code | Action |
|---|---|---|
| Camp `BLOCKED` right after configuring a hub | `kube-fleet-config-invalid` (thrown at start) | Fix the configuration record: https API base URL without a path, a credential reference, DNS-1123 cluster names, a known `DepartureAction`. |
| Every pass `BLOCKED` | `kube-auth-failed` | The hub refused the token. Grant the hub identity get/list/watch/create/update/delete on ManifestWorks (OCM), templates + PropagationPolicies + ResourceBindings (Karmada) or ClusterProfiles. |
| `BLOCKED` with a credential code | `kube-credential-missing` / `-unsupported` / `-expired` | Store `{ token }` under the hub's `credential_ref`, or make the host's exec plugin return a fresh ExecCredential token (client certificates are not supported over `HttpTransport`). |
| `BLOCKED` with `kube-unavailable` | `kube-unavailable` | The hub API failed (5xx, 429, transport). Nothing is assumed converged; the reconciler retries. Check hub health and network reach from the reconciler. |
| `BLOCKED` with `stale-fence` | `stale-fence` | This process lost the Camp lease. Stop it; the current holder owns the Camp. |
| `BLOCKED` with `kube-cluster-unmapped` | `kube-cluster-unmapped` | Add a `CampClusterRecord` for the Camp to the realizer configuration. |
| `BLOCKED` with `kube-object-unrenderable` / `kube-kind-unknown` / `kube-name-invalid` / `kube-secret-refused` | as named | Fix the declaration: give the resource a manifest or a known product with a spec; declare `resource` and `namespaced` for custom kinds; use DNS-1123 names; reference secrets instead of shipping them. |
| OCM Camp stays `CONVERGING` | `ocm-work-not-applied` / `ocm-work-not-available` / `ocm-feedback-missing` / `kube-workload-not-ready` | Check the ManagedCluster is joined and its work agent runs (`kubectl get manifestwork -n <cluster>`); HoBo verification decides at the deadline. |
| OCM Camp `BLOCKED` | `ocm-work-apply-failed` | Read the manifest condition message in the reason; fix the declaration and promote again, or roll back through HoBo. |
| OCM Camp `DRIFTED` | `ocm-work-missing` / `ocm-work-modified` | Someone deleted or edited the ManifestWork on the hub. The reconciler re-applies per the drift policy. Change the declaration, not the hub. |
| OCM Camp `CONVERGING` after a promotion | `ocm-superseded-work-pending` | The previous work is being removed; resources only it declared follow the `DepartureAction`. Wait one pass. |
| Karmada Camp `BLOCKED` | `karmada-template-conflict` | Another Camp (or something outside HoBo) owns a template with the same name and namespace. Give each Camp its own namespace via a Camp mapping rule. |
| Karmada Camp `BLOCKED` | `karmada-pinning-violated` | A binding names a cluster other than the Camp's member: an OverridePolicy, a Karmada failover or another policy changed placement. Remove it; HoBo never lets Karmada schedule or fail over a delivery. |
| Karmada Camp `CONVERGING` | `karmada-binding-pending` / `karmada-member-unhealthy` | Wait for the binding controller; read the binding's `aggregatedStatus` for the member's message. |
| Karmada departure leaves a template | `karmada-keep-retained` | The departure keeps it but its policy does not preserve member resources. Delete it by hand once the data is safe, or keep it. |
| Imported Camps missing | `clusterprofile-invalid` / `clusterprofile-camp-collision` (skip reasons) | Fix the profile on the inventory hub, or give imports distinct `camp_id_prefix` values. |
| Watch keeps re-listing | metric `watch.relists` climbs | The hub compacts history faster than the watch interval; lower `watch_timeout_seconds` or check the API server's etcd compaction. |
| Member API unreachable | `clusterprofile-access-missing` | The profile names no https access provider. Install an access-provider plugin on the inventory hub. |

### Live kind lane

`test/kind-lane.test.ts` runs both realizers against real hubs and skips with
the missing variable named when they are absent. To run it:

1. Create a hub and a managed cluster with `kind`, install OCM
   (`clusteradm init` on the hub, `clusteradm join` from the member) and/or
   Karmada (`karmadactl init` against a kind host cluster, `karmadactl join`
   a kind member).
2. Create a service-account token with the RBAC above on each control plane.
3. Export `HOBO_KIND_OCM_API`, `HOBO_KIND_OCM_TOKEN`, `HOBO_KIND_OCM_CLUSTER`
   and/or `HOBO_KIND_KARMADA_API`, `HOBO_KIND_KARMADA_TOKEN`,
   `HOBO_KIND_KARMADA_MEMBER`, plus `NODE_EXTRA_CA_CERTS` pointing at the
   clusters' CA bundle.
4. `pnpm --filter @hobo/cd-kube-fleet test`.
