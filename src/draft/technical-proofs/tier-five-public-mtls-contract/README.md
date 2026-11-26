# Tier-Five Public mTLS Contract POC

Independent proof for HOBO-134.

This package pins the M2 tier-five networking realization contract from:

- `docs/design/security-networking.md#plan-12`: public + mTLS is the last-resort connectivity tier.
- `src/draft/technical-proofs/connectivity-tier-ir-contract`: HOBO-89's `ConnectivityPlan` and `PUBLIC_MTLS` tier.
- `src/draft/technical-proofs/mtls-data-path-contract`: HOBO-117's workload-SVID keyed mTLS decision contract.
- `src/draft/technical-proofs/connectivity-policy-enforcement-contract`: HOBO-210's consumed can-deploy policy decision seam.
- `src/draft/technical-proofs/tier-four-overlay-mesh-contract`: HOBO-129's explicit tier-four fall-through boundary.

The proof covers:

- A tier-five edge records `ConnectivityTier.PUBLIC_MTLS` and produces topology output flagged as public.
- The dependency endpoint is reachable only via mutual TLS with the bind-derived source/client SVID.
- A syntactically valid client certificate with the wrong SPIFFE ID is rejected.
- Plain TLS without a client SVID certificate fails closed.
- A prod policy decision forbidding public tier blocks before any public endpoint topology is produced.
- Tier five requires explicit fall-through evidence from tier four.
- Source and target SVIDs must name the resources on the bind edge.

Scope boundary: this POC does not issue SVIDs, configure real certificates, implement tiers 1-4,
author governance policy packs, provision public ingress, or call provider APIs. It models the narrow
tier-five realization seam that consumes existing tier IR, mTLS, policy, and tier-four fallback
contracts.

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\tier-five-public-mtls-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Tier Five Public Mtls Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
