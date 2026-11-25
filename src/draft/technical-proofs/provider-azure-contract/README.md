# HOBO-157 Azure Provider Contract POC

This draft package proves the `@hobo/provider-azure` contract slice for
[PLAN-04](../../../../docs/design/control-plane.md#plan-04),
[PLAN-25](../../../../docs/design/platform-engineering.md#plan-25),
[ADR-0024](../../../../docs/design/adr/07-portability-extensibility.md#adr-0024),
and [ADR-0035](../../../../docs/design/adr/07-portability-extensibility.md#adr-0035).

It covers the seed Azure provider surface:

- `createAzureProvider()` factory with `capabilityManifest()`, conformance hooks,
  default Resource Definitions, and per-port runtime `client()` methods;
- typed provider-specific `.with(...)` builders under `azure.with`;
- `database`, `objectStore`, `compute`, `queue`, and `cache` equivalence
  defaults for Flexible Server, Blob Storage, Container Apps, Service Bus, and
  Cache for Redis;
- `realizeAzurePlan()` emitting a driver-agnostic HoBo realization graph marked
  for `@hobo/iac-pulumi`;
- a multi-cloud-shop fixture that wires Postgres, blob storage, container
  compute, queue, and Redis cache through the same topology and bindings as the
  AWS proof;
- PortabilityReport entries for Azure-only `.with(...)` options, including
  provider-managed certificate selection from ADR-0035;
- negative cases for unavailable regional services, unsupported Azure role
  mappings, unsatisfied `require` facts, and quota exhaustion during apply.

Out of scope: real Azure SDK/Pulumi execution, AWS/GCP provider changes,
Junction connectivity, Front Door/global gateway, secretless token brokering,
and services beyond the seed ports.

Run:

```powershell
pnpm.cmd --prefix src\draft\technical-proofs\provider-azure-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Provider Azure Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
- `type-tests/provider-azure.ts` — public declaration consumer for the typed Azure provider API.
