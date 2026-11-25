# Usage Metering Scope Contract

This package is the executable M0 proof for HOBO-417. It records the accepted
Usage Metering scope, validates the required persona/scope/boundary/dependency
shape, and guards against implementation creep into billing, entitlements,
Dispatcher/CreditLedger routing, provider billing sync, tax, or live customer
usage.

The authoritative design record is
[`docs/design/usage-metering.md`](../../../../../docs/design/usage-metering.md).

## Proof

Run the focused proof with:

```powershell
npm.cmd --prefix src\draft\exp-proofs\cx\usage-metering-scope-contract test
```

The tests prove:

- user/business goal and primary personas are explicit;
- scope in/out, non-goals, and operating boundaries are recorded;
- dependencies map to the authoritative cost, event, billing, tax, showback,
  and credit-ledger sources;
- owning initiative boundaries are named without taking adjacent scope;
- M1 evidence requirements are listed with owner, source, proof mode, and claim;
- follow-up M1-M4 issue creation is blocked until M0 acceptance;
- excluded billing, entitlement, Dispatcher, provider sync, tax, and live usage
  work is rejected by the scope validator.


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Usage Metering Scope Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
