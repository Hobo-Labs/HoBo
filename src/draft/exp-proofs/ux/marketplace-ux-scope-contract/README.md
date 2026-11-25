# Marketplace UX Scope Contract

Executable M0 proof for HOBO-421.

This package records the accepted productization boundary for Marketplace UX before M1 design or
implementation issues can depend on it. It proves the user/business goal, primary personas,
scope-in, scope-out, service/UX/security/support boundaries, authoritative dependencies, owning
initiative dependencies, listing states, installability outcomes, M1 evidence, and follow-up gate.

The durable design record lives in
[`docs/design/marketplace-ux.md`](../../../../../docs/design/marketplace-ux.md). Branch evidence is
summarized in
[`docs/design/proofs/hobo-421-marketplace-ux`](../../../../../docs/design/proofs/hobo-421-marketplace-ux/README.md).

## Contract Surface

- `MARKETPLACE_UX_SCOPE` defines the accepted M0 scope record.
- `validateMarketplaceUxScope(scope)` checks required acceptance and adversarial boundaries.
- `canCreateMarketplaceUxFollowUp({ phase, m0Accepted })` blocks M1-M4 follow-up work until M0
  acceptance is recorded.

## Negative Coverage

Validation rejects scope creep into live storefronts, browse/search implementation, install runtime,
Registry storage, rating ranking, recommendations, paid placement, monetization, payouts,
publisher-portal UI, policy engines, RBAC runtime, scanner integration, support tooling, and
customer-visible installability claims without evidence source and owner route.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\marketplace-ux-scope-contract test
```

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` - protobuf data shapes and CUE constraints for Marketplace UX Scope.
- `architecture/pacts/` - PACT contract for the package boundary.
- `ADR.md` - parse-don't-validate and event-architecture evidence.
