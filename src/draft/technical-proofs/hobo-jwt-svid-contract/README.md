# HoBo JWT-SVID Contract POC

This draft pins the HOBO-44 contract as a small executable surface:

- `schema/jwt-svid.v1.schema.json` publishes the required JWT-SVID claim set.
- `src/jwt-svid.ts` parses Yard SPIFFE identities and validates compact JWT-SVIDs.
- `test/jwt-svid-contract.test.ts` covers the acceptance and adversarial cases from HOBO-44.

The compact JWT parser rejects unsigned tokens and `alg: none`, but it does not perform JWKS
signature verification. That belongs to the Identity issuer/JWKS runtime slice; this POC defines
the structural contract that runtime must verify against.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Hobo Jwt Svid Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
