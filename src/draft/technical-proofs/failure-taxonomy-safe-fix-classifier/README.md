# Failure Taxonomy Safe-Fix Classifier POC

Independent POC for HOBO-267. It pins the M0 classifier that maps documented SRE runtime and contract failure signals to canonical `RemediationAction` kinds from the HOBO-251 contract.

## Contract Surface

- `classifyFailureSignal(signal)` returns `{ failureClass, strategy, decisionBranch, action }`.
- Every documented class from `docs/design/operators-sre.md` is represented in `failureTaxonomyEntries`.
- Unknown signals fail closed to `escalate`.
- Ambiguous matches choose the most restrictive branch: `escalate` over `propose` over `auto-fix`.
- `requiresHuman` signals short-circuit to escalation before taxonomy matching.

## Scope Boundaries

This POC classifies and builds validated `RemediationAction` envelopes only. It does not diagnose incidents, execute runbooks, apply live fixes, run policy decisions, or perform remediation.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\failure-taxonomy-safe-fix-classifier test
npm.cmd test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Failure Taxonomy Safe Fix Classifier.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
