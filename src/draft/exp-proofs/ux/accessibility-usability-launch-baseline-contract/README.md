# Accessibility And Usability Launch Baseline Contract

HOBO-505 proof for the v1 accessibility and usability launch baseline.

## What This Proves

- Every v1 launch surface names an owning project and accessibility/usability evidence use.
- Required checks cover keyboard-only navigation, focus order, visible focus, semantic labels,
  contrast, responsive layout, reduced motion, screen-reader smoke, empty/error/loading states, and
  copy clarity.
- Evidence distinguishes automated checks, manual assistive-technology checks, beta feedback,
  defect severity, launch-blocker thresholds, and accepted-risk exceptions.
- Launch blockers and required evidence, CI, review, security, or contract-test gates cannot be waived.
- Defects route to owning product projects instead of a catch-all accessibility bucket.
- The M0 slice does not implement UI, run a full certification audit, or remediate every defect.

## Boundary

This package validates the M0 baseline record. It does not implement product UI, accessibility test
automation, manual audit execution, support tooling, launch cutline tooling, or downstream
remediation issues.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\accessibility-usability-launch-baseline-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Accessibility Usability Launch Baseline Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
