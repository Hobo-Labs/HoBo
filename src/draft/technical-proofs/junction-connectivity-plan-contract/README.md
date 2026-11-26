# Junction Connectivity Plan Contract POC

Independent proof for HOBO-159.

This package implements the branch-sized contract that follows the HOBO-185 spike:

- Input is the validated HOBO-94 `YardManifest` from each member Yard plus a tier-capability snapshot.
- The Junction runs the pure deterministic fold from `junction-connectivity-inference-spike`.
- The resulting `junction.ConnectivityInferred` event is packaged with per-Yard resource-log deliveries.
- Each Yard receives only its own `junction-connectivity-half`; the other Yard's half is not delivered to it.
- `sharedStateWrites` is intentionally empty: the Junction records what should connect, while each Yard owns how to realize its half.
- Residency mismatches and asymmetric manifests fail closed before any public+mTLS fallback.

The proof covers:

- Two member Yard manifests folding into a tier 3 private-interconnect plan with DNS rules.
- Mirrored per-Yard `resource.JunctionConnectivityHalfPlanned` deliveries.
- Validator rejection for leaked peer halves and incomplete half delivery projections.
- Fail-closed residency mismatch and missing peer endpoint behavior.

Scope boundary: this POC does not provision tier 3, tier 4, or tier 5 networking, promote DNS, implement Junction trust/policy federation, or implement the provider/Yard control planes. Those slices consume the per-Yard half deliveries produced here.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Junction Connectivity Plan Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
