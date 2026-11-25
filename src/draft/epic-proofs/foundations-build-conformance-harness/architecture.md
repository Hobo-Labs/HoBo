# Foundations Reference Architecture

## Overview

The Foundations epic supplies the first trust boundary for the rest of HoBo: package layout, shared contracts, WIT generation, component build artifacts, CI gates, artifact trust, and design hardening.

This reference implementation keeps those concerns in one vertical path:

1. `WorkspaceSkeletonBoundary` validates the pnpm/Turborepo skeleton and adapter import rules.
2. `CoreContractBoundary` validates the `@hobo/core` manifest, event envelope, and public type surface.
3. `WitToolchainBoundary` validates the `hobo:sdk` WIT skeleton and pinned generator lock.
4. `ComponentizeBuildBoundary` builds and validates the `hello-bindle` wasm component and OCI descriptor.
5. `ArtifactTrustBoundary` verifies signed artifact provenance before Matching visibility.
6. `CiFabricBoundary` proves PR gates plus opt-in E2E with mocked OIDC and teardown.
7. `HardeningTraceabilityBoundary` proves package namespace and ADR/Plan traceability alignment.

## Service Boundary Map

| Boundary | Kept from POCs | Revised for reference architecture | Mock strategy |
|---|---|---|---|
| WorkspaceSkeletonBoundary | Required packages, scripts, boundary import rejection | Treated as the first vertical slice rather than a standalone package proof | In-memory skeleton fixture |
| CoreContractBoundary | Capability Manifest bundle, EventEnvelope, public API guard | Cross-boundary event mappings are surfaced as simulation output | Fixture manifest and local declarations |
| WitToolchainBoundary | `hobo:sdk@0.1.0`, generator lock, vendored deps | Runtime primitive contents stay out of Foundations scope | Checked-in WIT and lock file |
| ComponentizeBuildBoundary | deterministic source collection, wasm validation, OCI descriptor | Real toolchain execution remains out of scope | Local fixture build bytes |
| CiFabricBoundary | PR gates, OIDC, hello-bindle E2E, teardown, sweeper | Live cloud execution is replaced by deterministic sandbox events | In-memory GitHub/OIDC/sandbox mocks |
| ArtifactTrustBoundary | signing, provenance, conformance, install verification | Registry listing lifecycle and transparency log are out of scope | Fixture Ed25519 key and trust policy |
| HardeningTraceabilityBoundary | CLI/API/namespace/traceability hardening | Reads docs as aggregate evidence, not a product feature | Local markdown docs |

## Personas and Vertical Slices

| Persona | Scenario | Vertical slice | Acceptance |
|---|---|---|---|
| Platform engineer | Bootstrap a workspace skeleton | `workspace-contract` | Required packages/scripts exist and adapter cross-imports are denied |
| Provider author | Compile against shared contracts | `contract-surface` | Core schema, EventEnvelope mappings, and WIT lock validate |
| Application developer | Build a deterministic component | `artifact-build` | wasm component validates and smoke invocation exits 0 |
| SecOps reviewer | Verify artifact trust | `trust-gate` | Signed artifact is available to Matching, not auto-selected |
| Maintainer | Run CI and E2E gates | `ci-conformance` | OIDC, teardown, sweeper, quarantine, and cost gates are covered |
| Design maintainer | Keep docs aligned | `hardening-traceability` | PLAN-10 and ADR coverage remain linked to issue families |

## Follow-ups

- Provider-side Pact verification should be added when production providers exist.
- HOBO-5's standalone PR remains separate; this rollup consumes its conformance-harness behavior as reference architecture evidence.
- WIT runtime adapter certification remains owned by the WIT Runtime epic, not this Foundations rollup.
## Guardrail evidence

Parse, don't validate: incoming command payloads, Pact fixtures, and protobuf/CUE-backed scenario records cross a parser boundary before the epic simulation uses them. The parsed domain types are the scenario commands, boundary fixtures, and role-flow records described above; mocked providers receive only those derived domain types, not raw DTOs.

Event architecture: command handlers in the epic actors emit events into an in-memory event-store. Materialized views and projections are rebuilt from that event stream, snapshots represent the current read model, and historical snapshots are retained in a read store so CLI, MCP, operator, and simulation reads never infer state from mutable provider internals.
