# Legal Privacy Terms Readiness Contract

HOBO-405 proof for the v1 legal, privacy, terms, support, and customer
communications launch checklist.

## What This Proves

- The launch checklist covers terms, privacy notice, data retention, telemetry,
  subprocessors/provider claims, security claims, support obligations, and customer
  communications.
- Every checklist item names owner, owning project, evidence source, customer-facing message,
  support action, audit evidence, and entitlement impact.
- Open legal/privacy unknowns are classified as launch blockers or explicit post-v1 follow-ups.
- Security, compliance/data-governance, organizational-governance, and scope records are linked.
- Follow-up launch work is blocked until this M0 checklist is accepted.

## Boundary

This package validates the launch-readiness checklist. It does not draft final legal terms,
publish compliance claims, implement support tooling, implement billing, or create downstream
M1-M4 work.

## Verification

```powershell
npm.cmd --prefix src\draft\exp-proofs\cx\legal-privacy-terms-readiness-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Legal Privacy Terms Readiness Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
