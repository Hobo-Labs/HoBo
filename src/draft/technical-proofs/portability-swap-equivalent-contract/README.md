# HOBO-388 Portability Swap-For-Equivalent Contract

This POC pins the distribution-level portability escape hatch from ADR-0024 and
ADR-0062: a pinned listing can be swapped for a conformance-equivalent listing
without editing app code and without any commercial or trust-tier gate.

## Contract

- Equivalence is a same `interface@version` plus same conformance suite/version.
- The swap gate checks only the interface and conformance boundary.
- Trust tier can influence policy elsewhere, but it does not gate the portability
  swap operation.
- If no equivalent listing is available, the operation returns a generation
  request for a conformance-equivalent adapter.
- Listing import and export remain available regardless of caller, trust, or
  commercial tier.

## Scope Boundary

This package does not implement the generation pipeline, Matching selection,
conformance suites, trust-tier policy, or production registry storage. It is a
contract slice for the distribution-level operation those systems consume.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\portability-swap-equivalent-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Portability Swap Equivalent Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
