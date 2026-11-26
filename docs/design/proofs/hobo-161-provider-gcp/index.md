# HOBO-161 GCP Provider Proof

This proof backs [PLAN-04](../../control-plane.md#plan-04), the provider
package slot in [architecture.md](../../architecture.md#monorepo--package-architecture), and
[ADR-0024](../../adr/07-portability-extensibility.md#adr-0024) portability
conformance.

The executable POC in
[`src/draft/technical-proofs/provider-gcp-contract`](../../../../src/draft/technical-proofs/provider-gcp-contract)
proves the GCP seed provider contract:

- `@hobo/provider-gcp` exposes a factory, Capability Manifest, default Resource
  Definitions, and per-port clients for database, object store, compute, queue,
  and cache;
- `gcp.with.cloudSql/gcs/cloudRun/pubSub/memorystore` are typed provider
  options and only survive when the resolved provider is GCP;
- the multi-cloud-shop fixture realizes Cloud SQL PostgreSQL, GCS, Cloud Run,
  Pub/Sub, and Memorystore into a HoBo realization graph with
  `@hobo/iac-pulumi` driver intent and no provider-dialect leakage;
- the same fixture preserves topology and bindings against the existing
  `@hobo/provider-aws` proof, while the Azure comparison remains owned by the
  Azure provider slice;
- local and camp conformance are both represented, with camp-only
  service-account IAM evidence failing the camp lane while local conformance
  still passes;
- GCP-only Cloud Run CPU allocation is surfaced in the PortabilityReport as a
  target-scoped provider option instead of being treated as portable;
- unavailable regions/services, unsatisfied `require` facts, and project-quota
  exhaustion return precise `deployment.PlanRejected` reasons.

Scope kept out: live GCP/Pulumi apply, AWS/Azure providers, cross-cloud
Junction connectivity, secretless token brokering, and the full GCP service
surface beyond the seed ports.
