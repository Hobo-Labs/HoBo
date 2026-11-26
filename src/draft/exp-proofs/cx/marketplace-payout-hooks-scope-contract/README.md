# Marketplace Payout Hooks Scope Contract

This package is the executable M0 proof for HOBO-420. It records the accepted
Marketplace Payout Hooks scope, validates the required persona/scope/boundary
and dependency shape, and guards against implementation creep into live payout
providers, settlement, tax documents, revenue-share policy, payout UI, KYC/KYB,
or money movement.

The authoritative design record is
[`docs/design/marketplace-payout-hooks.md`](../../../../../docs/design/marketplace-payout-hooks.md).

## Proof

Run the focused proof with:

```powershell
npm.cmd --prefix src\draft\exp-proofs\cx\marketplace-payout-hooks-scope-contract test
```

The tests prove:

- user/business goal and primary personas are explicit;
- scope in/out, non-goals, and operating boundaries are recorded;
- dependencies map to marketplace trust, capability review, org catalog,
  billing, tax, support, and scope ADR sources;
- owning initiative boundaries are named without taking adjacent scope;
- payout-readiness states are listed before M1 contract work;
- M1 evidence requirements are listed with owner, source, proof mode, and claim;
- follow-up M1-M4 issue creation is blocked until M0 acceptance;
- excluded payout provider, settlement, tax, UI, KYC/KYB, and revenue-share work
  is rejected by the scope validator.

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` - protobuf data shapes and CUE constraints for Marketplace
  Payout Hooks Scope Contract.
- `architecture/pacts/` - PACT contract for the package boundary.
- `ADR.md` - parse-don't-validate and event-architecture evidence.
