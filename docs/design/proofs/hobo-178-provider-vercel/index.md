# HOBO-178 Vercel Provider Proof

This proof backs [PLAN-04](../../control-plane.md#plan-04),
[PLAN-25](../../platform-engineering.md#plan-25),
[ADR-0005](../../adr/01-architecture-core.md#adr-0005),
[ADR-0024](../../adr/07-portability-extensibility.md#adr-0024), and
[ADR-0090](../../adr/01-architecture-core.md#adr-0090).

The executable POC in
[`src/draft/technical-proofs/provider-vercel-contract`](../../../../src/draft/technical-proofs/provider-vercel-contract/README.md)
pins the `@hobo/provider-vercel` contract:

- factory, `.with(...)` builders, default Resource Definitions,
  `capabilityManifest()`, and runtime client surfaces;
- Vercel CLI / Terraform intents for web/SSR, serverless/edge functions, and
  Blob;
- Neon and Upstash marketplace-backed resources represented as
  `integration-backed` PortabilityReport entries;
- provider-option scoping that drops non-Vercel `.with(...)` blocks;
- shared provider-conformance coverage for compute, objectStore, and database
  seed claims, including recorded camp evidence requirements;
- fail-closed guards for missing marketplace registrations, missing camp
  evidence, native-database requirements Vercel cannot satisfy, Blob/S3
  divergence, edge duration limits, and unsupported regions.

Scope kept out: real Vercel API execution, marketplace brokering internals,
workload-profile selection, and the broader Vercel service surface beyond the
seed capabilities named by HOBO-178.
