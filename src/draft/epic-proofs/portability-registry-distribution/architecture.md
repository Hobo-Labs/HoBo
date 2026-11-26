# Reference Architecture

## Epic outcome

Portability, Registry & Distribution needs one common flow: a listing is certified, discoverable, resolvable, verifiable, policy-gated, installable, yanked when compromised, and importable offline. The reference implementation composes existing POC contracts into that flow with mocked boundaries.

## Personas

| Persona | Goal | Reference slice |
|---|---|---|
| Platform engineer | Curate trusted provider inputs for production | Certified listing install and catalog policy gate |
| Planning agent | Discover a capability and freeze a digest pin | Capability index plus distributed-artifact resolver |
| SecOps responder | Block a compromised listing without rewriting running Sets | Yank lifecycle, doctor findings, remediation obligation |
| Sovereign Yard operator | Import signed bundles without egress | Offline bundle import into an in-boundary mirror |

## Vertical slice map

| Slice | Inputs | Boundaries | Observable outcome |
|---|---|---|---|
| Certified install | Registry descriptor, signed artifact, conformance report | Artifact repository, trust verifier, catalog policy | Artifact available to Matching, not selected |
| Agent discovery | WIT interface query and catalog snapshot | Capability discovery index, resolver | Deterministic digest pin in manifest IR |
| Safe mirror fetch | Frozen digest pin and mirror set | Artifact mirrors, Dispatcher cost tie-break | Cost selected only among digest-identical mirrors |
| Supply-chain response | Critical yank command | Listing lifecycle, policy obligation | New deploy blocked, running Set flagged |
| Air-gap import | Signed offline bundle plus offline trust material | Offline importer, in-boundary mirror | BundleImported event, no live egress |

## Service boundaries

| Boundary | Type | Consumer | Provider | Contract strategy |
|---|---|---|---|---|
| Capability discovery | Internal service boundary | Registry reference app | Capability discovery index | Pact request-response fixture over query/result shape |
| Artifact repository | External integration port | Registry reference app | Artifact repository mirror | Pact request-response fixture over digest-pinned pull |
| Trust and policy gate | Internal service boundary | Registry reference app | Install verifier plus trust/catalog policies | Pact message fixture over decision/evidence shape |
| Offline import | External air-gap boundary | Registry reference app | Bundle importer and in-boundary mirror | Pact message fixture over import command/event shape |

## Scope review

Accepted POCs map to the epic because they describe either the registry listing lifecycle, the install/verification boundary, the resolver, the artifact repository port, distribution trust policy, or air-gap import. Their implementation ideas kept here are pure functions, deterministic fixtures, fail-closed decisions, and event-shaped outputs.

Discarded or deferred details are production transports, real signing infrastructure, real external registries, storefront UX, full Junction federation, and global Matching scoring. Copying those into this reference implementation would make the simulation misleading by implying live infrastructure exists.

Contract brittleness risk is controlled by using consumer-owned boundary fixtures that assert request/response compatibility and decision evidence, not internal helper call order. The Pact fixtures intentionally avoid over-specific timestamps and real network locations.
## Guardrail evidence

Parse, don't validate: incoming command payloads, Pact fixtures, and protobuf/CUE-backed scenario records cross a parser boundary before the epic simulation uses them. The parsed domain types are the scenario commands, boundary fixtures, and role-flow records described above; mocked providers receive only those derived domain types, not raw DTOs.

Event architecture: command handlers in the epic actors emit events into an in-memory event-store. Materialized views and projections are rebuilt from that event stream, snapshots represent the current read model, and historical snapshots are retained in a read store so CLI, MCP, operator, and simulation reads never infer state from mutable provider internals.
