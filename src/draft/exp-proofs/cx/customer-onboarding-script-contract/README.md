# Customer Onboarding Script Contract

HOBO-487 proof for first-customer onboarding script and success criteria.

## What This Proves

- The onboarding script covers invite, workspace setup, sample-or-real project choice, first deploy,
  failure recovery, support handoff, and feedback capture.
- Success criteria cover time-to-first-success, blocker categories, handoff quality, and unresolved
  risk.
- Pilot notes route to release cutline, docs, product UX, support, or owning engineering surfaces.
- Future pilot usage is gated on accepted M0 evidence, script review, support owner, and customer
  consent.
- Scope guards reject onboarding automation, live customer data capture, support-tool
  implementation, and real deploy/provisioning creep.
- Raw script records parse into the `ParsedCustomerOnboardingScript` derived type before downstream
  surfaces consume them.

## Boundary

This package validates the M0 script contract. It does not automate onboarding, run pilots, collect
live customer data, implement support tooling, or execute a real first deploy.

## Verification

```powershell
pnpm.cmd --prefix src\draft\exp-proofs\cx\customer-onboarding-script-contract test
```

## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` - protobuf data shapes and CUE constraints for the script contract.
- `architecture/pacts/` - PACT contract for the package boundary.
- `ADR.md` - parse-don't-validate and event-architecture evidence.
