# HOBO-178 Vercel Provider Contract POC

This draft models the `@hobo/provider-vercel` provider package contract.

It proves:

- Vercel provider factory, scoped `.with(...)` builders, default Resource
  Definitions, runtime clients, and `capabilityManifest()`.
- `realize()` emits Vercel CLI / Terraform `vercel` intents for SSR web,
  serverless/edge functions, and Blob.
- Neon and Upstash marketplace-backed database/KV resources are explicit
  `integration-backed` PortabilityReport entries.
- Vercel provider-specific `.with(...)` blocks only affect Vercel-resolved
  resources; other-provider blocks are dropped with an audit reason.
- Shared provider-capability conformance passes for claimed seed capabilities
  only when local checks and recorded camp evidence are both present.
- Marketplace integration gaps, missing camp evidence, unsupported native DB
  requirements, Blob-vs-S3 divergence, edge duration limits, and unsupported
  regions fail closed.

Scope kept out: real Vercel API calls, marketplace brokering depth, workload
profile selection, non-Vercel providers, and full Vercel product surface.

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\provider-vercel-contract test
```

Design refs:

- `docs/design/control-plane.md`: Vercel seed provider row, CloudProvider shape,
  `realize()` pipeline, IaC adapters, provider authoring.
- `docs/design/architecture.md`: `providers/*` package layer and public type
  surface convention.
- `docs/design/adr/07-portability-extensibility.md#adr-0024`: portability
  conformance and PortabilityReport gate.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Provider Vercel Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
