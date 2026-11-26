# HOBO-157 Azure Provider Contract Proof

This proof records the acceptance evidence for the independent
`src/draft/technical-proofs/provider-azure-contract` package.

## Acceptance Mapping

| Requirement | Executable proof |
|---|---|
| `@hobo/provider-azure` factory publishes typed builders, default definitions, conformance hooks, runtime clients, and capability manifest coverage for database, objectStore, compute, queue, and cache. | `factory publishes Azure seed capabilities, scoped option builders, defaults, and cost manifest` |
| The Azure provider passes provider-conformance for local and Camp checks across every claimed port. | `Azure provider passes local and camp provider-capability conformance for every claimed port` |
| The multi-cloud-shop fixture realizes the same topology and bindings to Azure through `@hobo/iac-pulumi`. | `multi-cloud-shop fixture realizes DB, blob, compute, queue, and cache through Pulumi-shaped Azure nodes` |
| The fixture keeps portable shape identical to the existing AWS proof. | `multi-cloud-shop fixture preserves topology and bindings against the existing AWS provider proof` |
| Azure-scoped `.with(...)` options only affect Azure-resolved resources and produce portability findings. | `provider-scoped .with blocks only affect Azure-resolved resources and report Azure-only features` |

## Adversarial Mapping

| Adversarial case | Executable proof |
|---|---|
| Claims-to-roles mapping differences versus AWS must not silently change behavior. | `adversarial service availability, roles mismatch, and quota exhaustion reject with precise reasons` checks unsupported `Owner` role rejection. |
| Region missing a claimed service must reject precisely. | Same test rejects `centralindia` for Flexible Server availability. |
| Azure-only `.with(...)` blocks must surface in the PortabilityReport. | The provider-scoped `.with(...)` test asserts `zoneRedundantHa`, `immutableStorage`, and `daprEnabled` entries. |
| Quota or throttling exhaustion mid-apply must be explicit. | Same adversarial test rejects zero compute quota with `azure-quota-throttling`. |
| Provider-managed certificate selection must not become a hidden portability default. | `provider-managed App Service certs are explicit portability findings, not hidden defaults` asserts the ADR-0035 finding. |

## Scope Boundary

The package is a contract proof only. It does not execute Azure SDK or Pulumi
calls, implement AWS/GCP/other providers, provide Front Door or Junction routing,
or broker secretless credentials.

## Local Gate

```powershell
npm.cmd --prefix src\draft\technical-proofs\provider-azure-contract test
```
