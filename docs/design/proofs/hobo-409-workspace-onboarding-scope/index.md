# HOBO-409 Workspace & Onboarding UX M0 Scope Proof

HOBO-409 is proven by the focused M0 contract at
[`src/draft/exp-proofs/ux/workspace-onboarding-scope-acceptance`](../../../../src/draft/exp-proofs/ux/workspace-onboarding-scope-acceptance/README.md)
and the durable scope record at [workspace-onboarding-ux.md](../../workspace-onboarding-ux.md).

## Acceptance Evidence

- User and business goal is explicit for launch-safe first-run activation.
- Primary personas cover first-time app developer, team admin, platform engineer, and support
  operator.
- Scope in, scope out, non-goals, and service/UX/security/support boundaries are recorded.
- Dependencies map to Plan 17, Plan 07, the walkthrough, Plan 19, Example Apps, and ADR-0064.
- Owning initiative dependencies map onboarding, settings/project lifecycle, org/workspace model,
  example apps, customer onboarding, support workflow, and release cutline without taking their
  scope.
- M1 evidence is listed as activation rail map, persona scenarios, state model, telemetry contract,
  and recovery/support handoff fixtures.
- Follow-up M1-M4 work is blocked until M0 acceptance is recorded.

## Negative Coverage

- Scope validation rejects dashboard, auth/account, billing, production instrumentation, customer
  script, and live-customer creep inside M0.
- Evidence validation rejects user-visible claims without proof mode and source.
- Follow-up gating refuses M1-M4 issue creation while M0 is not accepted.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\workspace-onboarding-scope-acceptance test
```
