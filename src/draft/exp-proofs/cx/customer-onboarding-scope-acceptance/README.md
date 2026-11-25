# Customer Onboarding Scope Acceptance

Executable M0 productization contract for HOBO-449.

This package records the accepted scope boundary for the Customer Onboarding
project before M1 design or implementation issues fan out. It is intentionally
not a CRM, customer-success workflow, sales workflow, onboarding UI, support
queue, marketing site, billing flow, telemetry pipeline, live customer-data
import, production tenant mutation, or provider-backed customer launch.

## What It Proves

- The user/business goal and primary personas are explicit.
- Scope in, scope out, and non-goals are machine-checkable.
- Service, UX, security, and support boundaries are mapped.
- Owning initiative dependencies are mapped to Workspace & Onboarding UX,
  Persona Operating Profile, Pre-Launch Outcome Contract, Beta Pilot Feedback,
  Launch Support Desk, and Release Cutline.
- M1 evidence is listed before follow-up customer-onboarding work can start.
- Follow-up M1-M4 work is blocked until M0 scope acceptance is recorded.
- Scope creep into CRM/customer-success systems, live customer data, marketing
  or sales surfaces, proofless customer-facing claims, and M0-backed production
  launch or go-live claims is rejected.

## Architecture Evidence

- `ARCHITECTURE.md` records the parse, don't validate boundary, derived domain
  types, commands, events, actor, event-store, materialized view/projection,
  snapshot, and read store.
- `contracts/pacts/customer-onboarding-scope.pact.json` records the PACT
  boundary for beta pilot readiness consumption.
- `proto/customer_onboarding_scope.proto` and
  `cue/customer_onboarding_scope.cue` pin the M0 data shapes and constraints.

## Verification

Run the focused proof:

```powershell
pnpm.cmd --prefix src\draft\exp-proofs\cx\customer-onboarding-scope-acceptance test
```

Run the base-aware architecture guard used by CI:

```powershell
pnpm.cmd run architecture:guard -- --base=origin/main
```

The proof is also referenced by the design records:

- [Customer Onboarding design record](../../../../docs/design/customer-onboarding.md)
- [HOBO-449 proof record](../../../../docs/design/proofs/hobo-449-customer-onboarding-scope/README.md)
