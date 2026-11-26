# HOBO-161 GCP Provider Contract POC

This draft package proves the `@hobo/provider-gcp` contract slice for
[PLAN-04](../../../../docs/design/control-plane.md#plan-04) and
[ADR-0024](../../../../docs/design/adr/07-portability-extensibility.md#adr-0024).

It covers the seed GCP provider surface:

- `createGcpProvider()` factory with `capabilityManifest()`, conformance hooks,
  default Resource Definitions, and per-port runtime `client()` methods;
- typed provider-specific `.with(...)` builders under `gcp.with`;
- `database`, `objectStore`, `compute`, `queue`, and `cache` equivalence
  defaults;
- `realizeGcpPlan()` emitting a driver-agnostic HoBo realization graph marked
  for `@hobo/iac-pulumi`;
- a multi-cloud-shop fixture that wires Cloud SQL PostgreSQL, GCS, Cloud Run,
  Pub/Sub, and Memorystore through HoBo links and build references;
- an executable portability check that compares the GCP fixture topology and
  bindings against the existing AWS provider proof;
- GCP-only Cloud Run CPU allocation surfaced in the PortabilityReport instead
  of silently claiming cross-provider portability;
- negative cases for camp-only service-account IAM evidence, unavailable
  regions/services, unsatisfied `require` facts, and project-quota exhaustion.

Out of scope: real GCP SDK/Pulumi execution, AWS/Azure providers, Junction
connectivity, token brokering, and services beyond the seed ports.

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\provider-gcp-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Provider Gcp Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `type-tests/provider-gcp-types.ts` — public declaration consumer for the typed GCP provider API.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
