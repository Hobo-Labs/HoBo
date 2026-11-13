# HoBo.CD runbooks

Operator procedures for `@hobo/cd` ([design](../../design/continuous-delivery.md),
[ADR-0182](../../design/adr/01-architecture-core.md#adr-0182)). Each page is
assembled from the **Runbook** section of the owning module's README, which
stays the source of truth (plan 0024 §7.11). Every refusal HoBo.CD returns
carries a `ReasonRecord` with a `code` and a `remediation`; start from the code
or the symptom below.

## Symptom index

| Symptom or code | Start here |
|---|---|
| `hobo serve cd` not ready, `compose-realizer-missing`, `compose-store-multinode`, `cd-store-unavailable` | [Composition and the hobo binary](./compose.md), [Service host](./service.md) |
| New image or commit never becomes Freight; `unverified-trigger` | [Freight sources](./sources.md), [Freight ingest](./ingest.md), [Provenance](./provenance.md) |
| Freight yanked, retired, or an approval expired | [Freight ledger](./freight.md) |
| Promotion waits: `lineage-unsatisfied`, `AWAITING_WINDOW`, `window-closed` | [Pipelines](./pipelines.md), [Change windows](./windows.md), [Promotion](./promotion.md) |
| Promotion rejected by the gate, superseded, or rollback refused past a Trails `contract` | [Promotion](./promotion.md), [Sets and Deltas](./sets.md) |
| Camp does not converge; lease fenced; drift reported; resolved plan missing at agent | [Reconcilers and drift](./reconcile.md) |
| Verification FAIL or INCONCLUSIVE; no data | [Verification](./verification.md) |
| `progressive-unsupported`; traffic still split after success | [Rollout](./rollout.md) |
| Agent cannot read its feed; `enrollment-incomplete`; DPoP refused; SVID expiring | [Agents and enrollment](./agent.md), [Delivery feed](./feed.md) |
| Camp `NO_PLACE`, `CLAIMS_CONSISTENT=false`, `REACHABLE=false` | [Camp inventory](./inventory.md) |
| `placement-unsatisfiable`; unexpected Camp selection | [Placement](./placement.md) |
| Fan-out halted, Camps deferred, `fanout-budget-exceeded` | [Fan-out](./fanout.md) |
| `failover-unsafe`; failover waiting for approval; work did not fail back | [Failover and rebalance](./failover.md) |
| `shadow-required`, `ownership-conflict`, Camp noncompliant | [Policy delivery and posture](./posture.md) |
| Action denied; agent action recorded as a proposal | [Authorization](./authz.md) |
| Alerts, SLOs, DORA metrics, reconcile lag | [Telemetry and alerts](./telemetry.md) |
| CDEvents or webhooks not delivered; dead-lettered webhook | [Standards boundary](./boundary.md) |
| Artifact corrupted at rest; blob missing | [Artifact store](./artifacts.md) |
| Argo CD / Flux publisher not converging | [GitOps publisher](./cd-gitops.md) |
| ClusterProfile import, ManifestWork or Karmada binding problems | [Kubernetes fleets](./cd-kube-fleet.md) |
| Resolver component denied egress, trapped, or out of fuel | [Resolver components](./resolver-components.md) |
| PostgreSQL journal: lease lost, version too old, pool exhausted | [PostgreSQL journal](./storage-postgres.md) |

## Re-assembling

When a module's Runbook section changes, regenerate its page here: copy the
section under `## Procedures`, keep the front matter, and turn relative links
into the plain path they name.
