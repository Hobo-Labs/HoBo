# Publisher Portal Scope Contract

This package is the executable M0 proof for HOBO-422. It records the accepted
Publisher Portal productization scope, validates the required persona/scope
boundary shape, and guards against implementation creep into portal UI, review
decisioning, live Registry storage, payouts, billing, or support tooling.

The authoritative design record is
[`docs/design/publisher-portal.md`](../../../../../docs/design/publisher-portal.md).
Branch evidence is summarized in
[`docs/design/proofs/hobo-422-publisher-portal`](../../../../../docs/design/proofs/hobo-422-publisher-portal/README.md).

## Proof

Run the focused proof with:

```powershell
npm.cmd --prefix src\draft\exp-proofs\publisher-portal-scope-contract test
```

The tests prove:

- user/business goal and primary personas are explicit;
- scope in/out, non-goals, and operating boundaries are recorded;
- dependencies map to marketplace trust, capability review, payout hooks, org
  catalogs, billing, support, Registry, governance, and scope ADR sources;
- owning initiative boundaries are named without taking adjacent scope;
- publisher portal states are listed before M1 contract work;
- M1 evidence requirements are listed with owner, source, proof mode, and claim;
- follow-up M1-M4 work is blocked until M0 acceptance;
- excluded UI, approval-service, Registry, payout, billing, and support tooling
  work is rejected by the scope validator.

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` - protobuf data shapes and CUE constraints for Publisher
  Portal Scope Contract.
- `architecture/pacts/` - PACT contract for the package boundary.
- `ADR.md` - parse-don't-validate and event-architecture evidence.
