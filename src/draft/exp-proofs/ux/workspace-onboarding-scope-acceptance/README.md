# Workspace & Onboarding UX Scope Acceptance

HOBO-409 proof for Workspace & Onboarding UX M0 scope and acceptance.

The package exports a machine-checkable record in `src/workspace-onboarding-scope.mjs` and validates
that:

- goal, personas, scope, non-goals, and service/UX/security/support boundaries are explicit;
- dependencies map to authoritative design sources;
- owning initiative dependencies are named without taking their implementation scope;
- M1 proof evidence has owner, source, proof mode, and assertion;
- M1-M4 follow-up issues are blocked until M0 acceptance;
- scope creep into dashboard, auth/account, billing, production instrumentation, customer scripts,
  or live-customer data is rejected.

Run:

```powershell
npm.cmd --prefix src\draft\exp-proofs\workspace-onboarding-scope-acceptance test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Workspace Onboarding Scope Acceptance.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
