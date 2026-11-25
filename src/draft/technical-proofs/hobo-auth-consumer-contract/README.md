# HoBo hobo:auth Consumer Contract POC

Independent proof for HOBO-63: a consumer-driven `hobo:auth` contract and the
contract-asserted dev principal used by `hobo dev`.

## Contract Surface

- `defineAuthConsumerContract(input)` normalizes the expected `ctx.user`
  subject shape: claims, roles, scopes, platform tenant, and app tenant.
- `generateDevPrincipalFixture(contract, overrides)` creates an offline
  `contract-asserted-dev-principal` that satisfies the same contract a production
  IdP adapter must satisfy at `can-deploy`.
- `canonicalDevContractBytes(contract)` and
  `canonicalCanDeployContractBytes(contract)` return identical canonical bytes;
  there is no dev-only contract fork.
- `requireGrantedCapability(...)` proves auth bypass is not authz bypass:
  unlinked or ungranted capability calls fail closed.
- `verificationBoundary.notAssertedByContract` records the honest gap:
  JWKS, JWT `alg`, issuer, audience, expiry, and revocation belong to the
  fixture-IdP `can-deploy` gate, not to this consumer contract.

## Proof Boundaries

This POC proves offline principal shape and contract equivalence. It does not
verify real IdP JWTs, fetch JWKS, validate JWT signatures, model revocation, or
implement the `hobo:auth` runtime adapter.

## Executable Checks

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\hobo-auth-consumer-contract test
```

The checks prove fixture generation, per-session role/tenant overrides,
contract-shape rejection, byte-identical dev/prod contract bytes, deny-by-default
capability guardrails, and the documented JWT verification gap.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Hobo Auth Consumer Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
