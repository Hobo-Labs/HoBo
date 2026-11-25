# Providers, IaC & Build Architecture

## Overview

Providers turn HoBo's abstract resource graph into deployable infrastructure while preserving the same ports/adapters contract across clouds, IaC engines, build engines, and generated provider packages. This reference implementation keeps the epic scoped to the provider layer:

1. Provider packages publish factory builders, typed `.with(...)` options, default Resource Definitions, runtime clients, and signed Capability Manifests.
2. The conformance gate decides whether a claimed port can be selected.
3. The equivalence resolver maps abstract ports to provider-owned defaults and rejects hard capability misses.
4. `realize()` emits `IacProgram`, `BuildSpec`, and runtime link fixtures.
5. IaC, build, and non-IaC drivers consume those fixtures through mocked boundaries.
6. Drift, partial apply, import/adopt, malicious-provider, generation, and Resource Pack paths all fail closed unless evidence is present.

## Boundary Map

| Boundary | What crosses it | Mock strategy |
|---|---|---|
| ProviderPackageRegistry | Provider package metadata, defaults, clients, manifests | Deterministic registry fixture |
| ProviderConformanceGate | Claimed WIT/provider ports and reports | Static pass/fail report fixture |
| EquivalenceResolverCatalog | Provider-owned equivalence entries and require/prefer decisions | Catalog snapshot fixture |
| CapabilityManifestRegistry | Signed capabilities/auth/cost/regions | Signed manifest fixture |
| RealizeEmissionBoundary | ResourcePlan -> IacProgram/BuildSpec/link outputs | Static emission fixture |
| PortabilityReportGate | Lock-in report and can-deploy signal | Static report fixture |
| IacBackendAdapter | preview/apply/destroy/refresh/import | Mock adapter fixture |
| BuildProviderAdapter | wasm/container/VM/microVM image refs | Mock OCI ref fixture |
| LocalContainerProvider | zero-infra local provider | Offline local fixture |
| ConcreteCloudProviderMatrix | concrete provider family coverage | Provider matrix fixture |
| DriverTaxonomyAdapter | terraform/template/echo/container/custom-webhook | Mock driver fixture |
| DriftImportRefreshBoundary | drift, orphan sweep, adopted/external resources | Drift/import fixture |
| GenerationCertificationSandbox | generated provider conformance and repair budget | No-egress sandbox fixture |
| ResourcePackDistribution | signed provider defaults bundle | Signed pack fixture |
| ExecutionHostDispatch | runner/build-machine provider decision | Pinned credit-ledger fixture |

## Architecture Decisions Preserved

- ADR-0005: one ports/adapters shape spans cloud, IaC, build, runner, and build-machine providers.
- ADR-0006: IaC is pluggable and state is per resource.
- ADR-0024: portability is a gate over declared non-portable surface, not a narrative claim.
- ADR-0033 and ADR-0090: provider-owned equivalence entries feed deterministic Matching and capability negotiation.
- ADR-0071: execution-host selection consumes a pinned credit ledger snapshot.
- ADR-0010: AI-generated providers can be trusted only through sandboxed conformance, provenance, and bounded repair.

## Not Production Implementation

The service module is a deterministic reference harness. It does not import provider SDKs, run IaC tools, invoke build engines, call registries, call model providers, provision resources, or touch live networks.
## Guardrail evidence

Parse, don't validate: incoming command payloads, Pact fixtures, and protobuf/CUE-backed scenario records cross a parser boundary before the epic simulation uses them. The parsed domain types are the scenario commands, boundary fixtures, and role-flow records described above; mocked providers receive only those derived domain types, not raw DTOs.

Event architecture: command handlers in the epic actors emit events into an in-memory event-store. Materialized views and projections are rebuilt from that event stream, snapshots represent the current read model, and historical snapshots are retained in a read store so CLI, MCP, operator, and simulation reads never infer state from mutable provider internals.
