# Remediation Safety Gate Contract

Independent POC for HOBO-313. It pins the guard that runs before autonomous
remediation apply: signal provenance and replay checks, destructive-action
corroboration, operator RBAC/scoped capability enforcement, and spend-cap
aggregation.

## Scope

- Consume the existing `RemediationAction` envelope from HOBO-251.
- Emit Crew `policy.Decided`, `crew.ActionProposed`, `crew.ActionDenied`, and
  `crew.HandoffRequested` facts where the gate blocks or escalates.
- Emit `remediationSafety.Decided` facts so replay can prove signal idempotency
  and aggregate near-cap split spend.

## Out of Scope

This package does not diagnose signals, define the RBAC model, execute
remediation, promote deltas, or implement the downstream gated apply path.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\remediation-safety-gate-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Remediation Safety Gate Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
