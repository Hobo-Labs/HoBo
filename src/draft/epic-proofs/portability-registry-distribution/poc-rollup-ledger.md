# POC Rollup Ledger

| POC | Source | Related Linear | Persona | BDD scenario | Vertical slice | Service boundaries | Pact contracts | Reference impl status | Disposition | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| Registry artifact descriptor | `src/draft/technical-proofs/registry-artifact-descriptor-contract` | HOBO-331 | Platform engineer | Install a certified provider listing | Certified install | Trust and policy gate | registry-trust-policy | verified | implemented_in_reference_impl | Keeps descriptor shape and evidence references; production schema validation stays in original POC. |
| Artifact repository port | `src/draft/technical-proofs/artifact-repo-port-contract` | HOBO-347 | Platform engineer | Install a certified provider listing | Certified install | Artifact repository | registry-artifact-repository | verified | implemented_in_reference_impl | Keeps digest-pinned pull/publish and registered mirror-set idea. |
| Signed offline bundle | `src/draft/technical-proofs/signed-offline-bundle-contract` | HOBO-350 | Sovereign Yard operator | Import a signed offline bundle | Air-gap import | Offline import | registry-offline-import | verified | implemented_in_reference_impl | Keeps bundle manifest and BundleImported event gates. |
| OCI artifact storage | `src/draft/technical-proofs/oci-artifact-storage-contract` | HOBO-354 | Platform engineer | Install a certified provider listing | Certified install | Artifact repository | registry-artifact-repository | not_started | deferred | Storage transport is not needed for mock-only reference flow; descriptor and mirror contracts carry the boundary. |
| Registry publish flow | `src/draft/technical-proofs/registry-publish-flow-contract` | HOBO-357 | Platform engineer | Install a certified provider listing | Certified install | Trust and policy gate | registry-trust-policy | verified | implemented_in_reference_impl | Kept as publish-certify-provenance requirement; signed artifact fixture supplies executable behavior; refreshed for the validated leaf hardening, with simulation and Pact evidence unchanged. |
| Capability-indexed discovery | `src/draft/technical-proofs/capability-indexed-discovery-contract` | HOBO-362 | Planning agent | Discover, resolve, and fetch | Agent discovery | Capability discovery | registry-capability-discovery | verified | implemented_in_reference_impl | Keeps MCP-shaped query and certified listing projection; refreshed for the latest technical-proof change, with simulation and Pact evidence unchanged. |
| Install verification | `src/draft/technical-proofs/hobo-add-install-verification-contract` | HOBO-365 | Platform engineer | Install a certified provider listing | Certified install | Trust and policy gate | registry-trust-policy | verified | implemented_in_reference_impl | Keeps available-to-Matching, not selected-by-Matching contract. |
| Version policy | `src/draft/technical-proofs/distributed-artifact-version-policy` | HOBO-336 | Planning agent | Discover, resolve, and fetch | Agent discovery | Capability discovery | registry-capability-discovery | verified | implemented_in_reference_impl | Kept as resolver policy input, not duplicated; latest leaf validation is absorbed without changing simulation evidence. |
| Version semantics spike | `src/draft/technical-proofs/version-compat-resolution-semantics` | HOBO-340 | Planning agent | Discover, resolve, and fetch | Agent discovery | Capability discovery | registry-capability-discovery | verified | implemented_in_reference_impl | Kept as accepted vector evidence behind resolver behavior. |
| Distributed artifact resolver | `src/draft/technical-proofs/distributed-artifact-resolver-contract` | HOBO-370 | Planning agent | Discover, resolve, and fetch | Agent discovery | Capability discovery | registry-capability-discovery | verified | implemented_in_reference_impl | Keeps deterministic digest pin and manifest IR output. |
| Mirror digest selection | `src/draft/technical-proofs/mirror-digest-selection-contract` | HOBO-374 | Planning agent | Discover, resolve, and fetch | Safe mirror fetch | Artifact repository | registry-artifact-repository | verified | implemented_in_reference_impl | Keeps verify-before-cost invariant. |
| Listing lifecycle yank | `src/draft/technical-proofs/listing-lifecycle-yank-contract` | HOBO-377 | SecOps responder | Yank a compromised listing | Supply-chain response | Trust and policy gate | registry-trust-policy | verified | implemented_in_reference_impl | Keeps no new selection, running Set flagged, remediation obligation. |
| Curated catalog policy | `src/draft/technical-proofs/curated-catalog-policy-contract` | HOBO-380 | Platform engineer | Install a certified provider listing | Certified install | Trust and policy gate | registry-trust-policy | verified | implemented_in_reference_impl | Keeps prod pre-approved-only policy gate; latest leaf validation is absorbed without changing simulation evidence. |
| Registry import | `src/draft/technical-proofs/registry-import-contract` | HOBO-383 | Sovereign Yard operator | Import a signed offline bundle | Air-gap import | Offline import | registry-offline-import | verified | implemented_in_reference_impl | Kept under offline integrity wrapper; live crawl remains out of scope. |
| Trust tier policy | `src/draft/technical-proofs/trust-tier-policy-contract` | HOBO-385 | Platform engineer | Install a certified provider listing | Certified install | Trust and policy gate | registry-trust-policy | verified | implemented_in_reference_impl | Keeps min-tier policy and advisory-by-default trust composite. |
| Portability swap equivalent | `src/draft/technical-proofs/portability-swap-equivalent-contract` | HOBO-388 | Platform engineer | Yank a compromised listing | Supply-chain response | Trust and policy gate | registry-trust-policy | not_started | deferred | Reference emits equivalent-listing remediation but does not implement full swap search. |
| Junction registry federation | `src/draft/technical-proofs/junction-registry-federation-contract` | HOBO-390 | Sovereign Yard operator | Import a signed offline bundle | Air-gap import | Offline import | registry-offline-import | not_started | split_follow_up | Cross-Yard propagation is a separate epic-scale topology concern. |
| Dependency-confusion guard | `src/draft/technical-proofs/registry-dependency-confusion-guard-contract` | HOBO-391 | Planning agent | Discover, resolve, and fetch | Safe mirror fetch | Artifact repository | registry-artifact-repository | verified | implemented_in_reference_impl | Keeps digest mismatch and poisoned mirror fail-closed behavior. |
| Registry compromise guard | `src/draft/technical-proofs/registry-compromise-guard-contract` | HOBO-393 | SecOps responder | Yank a compromised listing | Supply-chain response | Trust and policy gate | registry-trust-policy | verified | implemented_in_reference_impl | Keeps fresh re-verification, residual risk, and critical yank response. |
| Version pinning drift guard | `src/draft/technical-proofs/version-pinning-drift-guard-contract` | HOBO-395 | Planning agent | Discover, resolve, and fetch | Agent discovery | Capability discovery | registry-capability-discovery | verified | implemented_in_reference_impl | Keeps immutable pin and preview bump refusal rules. |
| Offline import integrity | `src/draft/technical-proofs/offline-import-integrity-contract` | HOBO-397 | Sovereign Yard operator | Import a signed offline bundle | Air-gap import | Offline import | registry-offline-import | verified | implemented_in_reference_impl | Keeps revocation, anti-rollback, transparency, and zero-egress checks. |
| Resource Pack distribution | `src/draft/technical-proofs/resource-pack-distribution-contract` | HOBO-228 | Platform engineer | Install a certified provider listing | Certified install | Artifact repository, trust and policy gate | registry-artifact-repository, registry-trust-policy | verified | implemented_in_reference_impl | Related provider POC accepted because Resource Packs are explicitly in this epic scope. |

## Cascade absorptions

| Referenced proof | Change | Effect on this rollup |
|---|---|---|
| `src/draft/technical-proofs/hobo-add-install-verification-contract` | latest validated leaf hardening | Install verification and registry trust evidence unchanged. |

## Adversarial findings

- Digest mismatch across mirrors must abort before cost ranking; otherwise a cheaper mirror becomes a substitution attack.
- Valid signatures are not proof of benign code; fresh capability re-verification and yank paths remain required.
- Offline import cannot depend on live CRL, OCSP, transparency, or registry reachability; all trust material must be carried in-boundary.
- Installing a listing must not automatically select it; Matching selection is a later planner decision.
- Yanked listings block new selection but do not rewrite already-running Sets; running Sets are flagged with obligations.

## Cascade absorptions (batch five)

| Referenced proof | Change | Effect on this rollup |
|---|---|---|
| `src/draft/technical-proofs/portability-swap-equivalent-contract` | latest validated leaf hardening | Portability equivalence and registry selection evidence unchanged. |
| `src/draft/technical-proofs/registry-import-contract` | latest validated leaf hardening | Offline import and registry trust evidence unchanged. |
| `src/draft/technical-proofs/registry-publish-flow-contract` | latest validated leaf hardening | Registry publish and artifact trust evidence unchanged. |

## Cascade absorptions (83d9b5c92)

| Referenced proof | Change | Effect on this rollup |
|---|---|---|
| `src/draft/technical-proofs/trust-tier-policy-contract` | final validated leaf hardening | Trust-tier and registry evidence unchanged. |
