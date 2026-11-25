# HOBO-435 Example Apps M0 Scope Proof

HOBO-435 is proven by the focused M0 contract at
[`src/draft/exp-proofs/dx/example-apps-scope-acceptance`](../../../../src/draft/exp-proofs/dx/example-apps-scope-acceptance/README.md)
and the durable scope record at [example-apps.md](../../example-apps.md).

## Acceptance Evidence

- Goal and personas are explicit for app developers, platform engineers, agent builders, and demo
  maintainers.
- Scope in, scope out, non-goals, and service/UX/security/support boundaries are recorded.
- Dependencies map to Plan 19, the role walkthrough, Plan 07, Plan 21, and ADR-0064.
- Owning initiative dependencies map Example Apps, launch messaging/demo assets, onboarding UX,
  customer onboarding, and release cutline consumption without taking their scope.
- M1 evidence is listed as catalog, scaffold smoke, command transcript, proof assets, and
  failure-mode contracts.
- Follow-up M1-M4 issues are blocked until M0 acceptance is recorded.

## Negative Coverage

- Scope validation rejects launch-demo or production-app creep inside M0.
- Evidence validation rejects user-visible claims without a proof mode.
- Follow-up gating refuses M1-M4 issue creation while M0 is not accepted.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\example-apps-scope-acceptance test
```
