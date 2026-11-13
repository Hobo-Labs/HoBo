# `src/karmada/` — Karmada realizer

`karmadaRealizer(deps): Realizer` delivers a Camp's Set as **resource
templates** on the Karmada control plane plus, per namespace, a
**PropagationPolicy pinned to exactly one member**:

```yaml
placement:
  clusterAffinity: { clusterNames: [<member>] }
  replicaScheduling: { replicaSchedulingType: Duplicated }
preserveResourcesOnDeletion: <per DepartureAction>
conflictResolution: Abort
propagateDeps: false
```

No OverridePolicy, no spread constraints, no `failover` block, no
ClusterPropagationPolicy: Karmada transports, HoBo places and fails over.

| File | Holds |
|---|---|
| `policy.ts` | `renderPolicy`, policy names (`hobo-<camp>`, `hobo-<camp>-data`), the policy resource index, `parseBinding`. |
| `realizer.ts` | `karmadaRealizer`: fence and conflict checks, departure, policy upsert before templates, template upsert, binding verification. |

- **Observation** comes from the ResourceBinding (`<name>-<kind>`): bound at the
  template's current `resourceVersion`, `spec.clusters` and
  `aggregatedStatus` naming only the member, `applied: true`,
  `health: Healthy`. Any other cluster is `karmada-pinning-violated`.
- **Attributes**: `status.*` observe fields come from the member status
  Karmada aggregates; other fields from the template.
- **Departure**: compute templates sit under `hobo-<camp>` (preserve only under
  `ORPHAN`), data templates under `hobo-<camp>-data` (preserve unless
  `DELETE`).

## Runbook

| Symptom | Action |
|---|---|
| `karmada-pinning-violated` | `kubectl get rb -n <ns> <name>-<kind> -o yaml`: find what added the cluster (an OverridePolicy, a ClusterPropagationPolicy with higher priority, a Karmada failover). Remove it. |
| `karmada-template-conflict` | Two Camps render the same template name and namespace. Give each Camp its own namespace via a Camp mapping rule. |
| `karmada-binding-pending` for long | Check `karmada-controller-manager` and `karmada-scheduler` logs; the binding must reach the template's current revision. |
| `karmada-member-unhealthy` | Read `aggregatedStatus[].appliedMessage` and the member's own events. |
| `karmada-keep-retained` | A kept compute template stays because its policy does not preserve member resources; delete it by hand once safe. |
