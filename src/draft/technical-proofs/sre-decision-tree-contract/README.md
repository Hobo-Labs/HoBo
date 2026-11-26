# SRE Decision Tree Contract POC

Independent POC for HOBO-280.

This package composes the existing SRE contracts into the Plan 40 decision
tree: diagnose from projections, classify the signal, derive a
RemediationAction, route through the policy gate, and emit replayable Crew and
Incident facts.

Proven behavior:

- a low-risk, non-prod provider-degraded signal routes to `auto-fix`.
- a production `compat.GateFailed` routes to `propose`.
- an unclassifiable SEV1 enters A2H escalation through `crew.HandoffRequested`.
- `requiresHuman` signals short-circuit into A2H escalation.
- a low-risk production signal cannot auto-fix.
- a non-green conformance state cannot auto-fix.

Scope boundary:

- no remediation apply, live-fix canary runtime, runbook execution engine,
  paging provider, or on-call integration is implemented here.
- existing HOBO-251, HOBO-267, and HOBO-276 draft contracts remain the source
  for RemediationAction, failure classification, and read-only diagnosis.

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\sre-decision-tree-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Sre Decision Tree Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
