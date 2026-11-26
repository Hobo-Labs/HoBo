# Pre-Launch Outcome Contract

HOBO-509 defines the M0 contract for recording a business outcome baseline before v1 deploys.

## What This Proves

- The minimal v1 outcome fields are explicit: intended business outcome, success signal, owner,
  cost cap, approval rule, failure rule, rollback expectation, and review date.
- Plan/diff, launch go/no-go, telemetry, beta feedback, support handoff, and release notes all map
  to the same baseline fields.
- Safe-test evidence and post-launch comparison evidence are distinct and named before M1 work.
- Privacy, retention, customer visibility, and support redaction boundaries are documented.
- QUI-92 and the competitive persona synthesis remain source evidence without implementing a full
  value loop, analytics warehouse, or automated ROI model.

## Boundary

This package validates the M0 contract. It does not build product UI, analytics storage, an ROI
model, a customer-success lifecycle, or a live-provider success detector.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\cx\pre-launch-outcome-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Pre Launch Outcome Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
