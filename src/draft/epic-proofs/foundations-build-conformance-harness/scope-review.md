# Scope Review

## Accepted POCs

| POC | Requirement proved | Persona | BDD scenario | Boundary | Kept | Discarded or revised |
|---|---|---|---|---|---|---|
| HOBO-1 / `hobo-monorepo-skeleton-contract` | Repo package topology and adapter boundary lint | Platform engineer | Bootstrap package skeleton | WorkspaceSkeletonBoundary | Required packages, scripts, boundary denial | No product monorepo conversion |
| HOBO-2 / `hobo-core-contract` | Shared contract surface | Provider author | Compile against shared core | CoreContractBoundary | Capability Manifest, EventEnvelope mappings, public API guard | Runtime/provider behavior |
| HOBO-3 / `hobo-wit-toolchain-contract` | WIT package floor | Provider author | Validate hobo:sdk WIT lock | WitToolchainBoundary | Package/version/imports/generator lock | Runtime primitive implementation |
| HOBO-4 / `hobo-componentize-contract` | Deterministic component artifact | Application developer | Build hello-bindle component | ComponentizeBuildBoundary | wasm validation, OCI descriptor, smoke | Real jco/cargo/TinyGo tool execution |
| HOBO-5 / `hobo-conformance` proof | Conformance as trust boundary | Maintainer | Require conformance evidence | CiFabricBoundary, HardeningTraceabilityBoundary | Conformance required before trust | Standalone conformance engine breadth |
| HOBO-6 / `ci-fabric-oidc-e2e-contract` | CI and keyless E2E gate | Maintainer | Run CI/E2E without secrets | CiFabricBoundary | OIDC, teardown, sweeper, quarantine | Live cloud E2E |
| HOBO-7 / `signed-artifact-publish-install-contract` | Artifact trust before Matching | SecOps reviewer | Verify signed artifact | ArtifactTrustBoundary | Signed artifact, provenance, conformance verification | Registry lifecycle, transparency log |
| HOBO-8 | CLI verb hardening evidence | Design maintainer | Keep command docs aligned | HardeningTraceabilityBoundary | Traceability linkage | CLI implementation |
| HOBO-9 | SDK API hardening evidence | Design maintainer | Keep public SDK/API docs aligned | HardeningTraceabilityBoundary | SDK contract source-of-truth linkage | SDK implementation |
| HOBO-10 | Namespace/glossary hardening | Design maintainer | Keep terms aligned | HardeningTraceabilityBoundary | Package namespace doc read | Separate SDK namespace POC integration |
| HOBO-11 | ADR/Plan traceability | Design maintainer | Keep coverage anchored | HardeningTraceabilityBoundary | PLAN-10 and ADR coverage evidence | Whole-suite traceability regeneration |

## Deferred or Out of Scope

| POC | Disposition | Reason |
|---|---|---|
| `hobo-sdk-aggregate-wit-contract` / HOBO-16 | out_of_scope_for_this_epic | Belongs to WIT Runtime/SDK idiom parity; Foundations only validates the WIT toolchain floor |
| `component-host-conformance-suite` / HOBO-29 | out_of_scope_for_this_epic | Belongs to WIT Runtime host certification |
| `slsa-provenance-certification-contract` / HOBO-312 | out_of_scope_for_this_epic | Generation certification provenance is separate; Foundations uses HOBO-7 artifact trust |
| `hobo-package-namespace-map` / HOBO-58 | out_of_scope_for_this_epic | SDK namespace POC is not integrated; docs are read only as hardening evidence |

## Adversarial Decisions

- Do not use live GitHub, OIDC, cloud, registry, Sigstore, or customer data.
- Do not let `@hobo/core` leak provider credentials or provider-specific symbols.
- Do not treat a signed artifact as selected by Matching; it is only eligible.
- Do not imply component-host parity; host certification remains a separate epic.
- Do not duplicate reference implementation locations outside `src/draft/epic-proofs/foundations-build-conformance-harness`.
