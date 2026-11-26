---
type: Runbook
title: "HoBo.CD runbook: Kubernetes fleets"
description: "ClusterProfile import and OCM/Karmada realizers. Assembled from the Runbook section of packages/cd-kube-fleet/README.md."
tags: [hobo, cd, runbook, cd-kube-fleet]
---

# HoBo.CD runbook: Kubernetes fleets

ClusterProfile import and OCM/Karmada realizers. This page is assembled from the **Runbook** section of `packages/cd-kube-fleet/README.md`,
which stays the source of truth; update that section and re-assemble. The
symptom index is [index.md](./index.md); the design is
[continuous-delivery.md](../../design/continuous-delivery.md).

## Procedures

| Symptom | Reason code | Action |
|---|---|---|
| Camp `BLOCKED` right after configuring a hub | `kube-fleet-config-invalid` (thrown at start) | Fix the configuration record: https API base URL without a path, a credential reference, DNS-1123 cluster names, a known `DepartureAction`. |
| Every pass `BLOCKED` | `kube-auth-failed` | The hub refused the token. Grant the hub identity get/list/watch/create/update/delete on ManifestWorks (OCM), templates + PropagationPolicies + ResourceBindings (Karmada) or ClusterProfiles. |
| `BLOCKED` with a credential code | `kube-credential-missing` / `-unsupported` / `-expired` | Store `{ token }` under the hub's `credential_ref`, or make the host's exec plugin return a fresh ExecCredential token (client certificates are not supported over `HttpTransport`). |
| `BLOCKED` with `kube-unavailable` | `kube-unavailable` | The hub API failed (5xx, 429, transport). Nothing is assumed converged; the reconciler retries. Check hub health and network reach from the reconciler. |
| `BLOCKED` with `stale-fence` | `stale-fence` | This process lost the Camp lease. Stop it; the current holder owns the Camp. |
| `BLOCKED` with `kube-cluster-unmapped` | `kube-cluster-unmapped` | Add a `CampClusterRecord` for the Camp to the realizer configuration. |
| `BLOCKED` with `kube-object-unrenderable` / `kube-kind-unknown` / `kube-name-invalid` / `kube-secret-refused` | as named | Fix the declaration: give the resource a manifest or a known product with a spec; declare `resource` and `namespaced` for custom kinds; use DNS-1123 names; reference secrets instead of shipping them. |
| OCM Camp stays `CONVERGING` | `ocm-work-not-applied` / `ocm-work-not-available` / `kube-workload-not-ready` | Check the ManagedCluster is joined and its work agent runs (`kubectl get manifestwork -n <cluster>`); HoBo verification decides at the deadline. |
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
