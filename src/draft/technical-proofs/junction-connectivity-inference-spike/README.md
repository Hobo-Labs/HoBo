# Junction connectivity inference spike

Independent proof for HOBO-185.

This spike narrows the HOBO-159 implementation contract for cross-Yard connectivity inference:

- Input is the validated HOBO-94 `YardManifest` from each member Yard.
- The Junction runs a pure deterministic fold over those manifests and a tier-capability snapshot.
- Every accepted cross-Yard link emits exactly two mirrored per-Yard halves.
- Cross-Yard tier precedence is tier 3 private interconnect, then tier 4 overlay mesh, then tier 5 public+mTLS. The manifest-required tier is the worst allowed tier; the fold selects the most private supported tier at or better than that requirement.
- Public+mTLS is never an implicit escape hatch. It is selected only when the manifest intent explicitly permits tier 5 and the capability snapshot supports it.
- Missing peer endpoints, unsupported tiers, residency mismatches, and incomplete half projections fail closed with explicit diagnostics.

The proof package covers:

- A two-Yard fixture that produces `junction.ConnectivityInferred` plus one source half and one target half.
- A deterministic generated-pair harness for completeness, soundness, residency legality, and input-order independence.
- Fail-closed cases for asymmetric manifests, no legal tier, unsupported same-Yard tiers, and residency conflicts.
- Positive precedence cases showing overlay beats public when both are legal, and public is accepted only when explicitly allowed.
- A validation check that rejects an inference output whose `halvesByYard` omits one mirrored half.

Scope boundary: this package does not implement production Junction realization, provider networking, DNS promotion, trust or policy federation, or Relay behavior. It only decides and proves the pure inference seam that HOBO-159 should implement.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Junction Connectivity Inference Spike.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
