# Capability Review & Approval Scope Contract

Executable M0 proof for HOBO-423.

This package records the accepted productization boundary for Capability Review & Approval before
M1 design or implementation issues can depend on it. It proves the user/business goal, primary
personas, scope-in, scope-out, service/UX/security/support boundaries, authoritative dependencies,
owning initiative dependencies, review states, M1 evidence, and follow-up gate.

The durable design record lives in
[`docs/design/capability-review-approval.md`](../../../../../docs/design/capability-review-approval.md).
Branch evidence is summarized in
[`docs/design/proofs/hobo-423-capability-review-approval`](../../../../../docs/design/proofs/hobo-423-capability-review-approval/README.md).

## Contract Surface

- `CAPABILITY_REVIEW_APPROVAL_SCOPE` defines the accepted M0 scope record.
- `validateCapabilityReviewApprovalScope(scope)` checks required acceptance and adversarial
  boundaries.
- `canCreateCapabilityReviewFollowUp({ phase, m0Accepted })` blocks M1-M4 follow-up work until M0
  acceptance is recorded.

## Negative Coverage

Validation rejects scope creep into marketplace review UI, publisher portal UI, storefront,
install-flow UX, monetization, paid publisher tiers, payouts, live Registry storage, security
scanner integration, policy engine enforcement, approval service implementation, and
customer-visible installability claims without proof source and owner route.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\cx\capability-review-approval-scope test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Capability Review Approval Scope.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
