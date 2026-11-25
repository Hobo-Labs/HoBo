# HOBO-165 Cloudflare Provider Proof

This proof backs [PLAN-04](../../control-plane.md#plan-04), the provider
package slot in [architecture.md](../../architecture.md#monorepo--package-architecture),
[ADR-0024](../../adr/07-portability-extensibility.md#adr-0024) portability
conformance, [ADR-0031](../../adr/01-architecture-core.md#adr-0031)
provider-native wasm opt-in, and [ADR-0035](../../adr/07-portability-extensibility.md#adr-0035)
safe DNS rollout.

The executable POC in
[`src/draft/technical-proofs/provider-cloudflare-contract`](../../../../src/draft/technical-proofs/provider-cloudflare-contract)
proves the Cloudflare seed provider contract:

- `@hobo/provider-cloudflare` exposes a factory, Capability Manifest, default
  Resource Definitions, and per-port clients for Workers, R2, D1/Hyperdrive,
  KV, Queues, and DNS;
- `cloudflare.with.worker/r2/d1/hyperdrivePostgres/kv/queues/dns` are
  provider-scoped options and only survive when the resolved provider is
  Cloudflare;
- the edge-shop fixture realizes a Worker plus R2 bucket, D1 database, KV
  namespace, Queue, and DNS record into a HoBo realization graph with
  `wrangler` for Workers and `terraform:cloudflare` for account resources;
- local and camp conformance are represented for the shared seed ports, with
  explicit KV evidence while the shared conformance catalog has no first-class
  `kv` suite;
- Cloudflare-only Worker Smart Placement, R2 S3-compatibility semantics, and
  proxied DNS are surfaced in the PortabilityReport as target-scoped provider
  options;
- `database{postgres,managed,require}` rejects, while a preference degrades to
  Hyperdrive plus Neon and records a PortabilityReport degradation;
- strong-consistency SQL, strict S3 edge semantics, Worker CPU/bundle limits,
  DNS changes missing an ADR-0035 safe-rollout gate, and account-quota
  exhaustion return precise `deployment.PlanRejected` reasons.

Scope kept out: live Terraform/Wrangler execution, Workers runtime component
hosting, Workers AI/Vectorize as first-class search resources, and other cloud
providers.
