# Live-fix gated candidate contract

Proof package for HOBO-368. It models the applier side of self-healing live-fix:
captured failing trace, generated candidate, sandbox/conformance/trace replay,
policy gate, canary/rollback, and permanent regression-test retention.

## Scope

- In: low-risk live-fix canary, rollback on regression, prod/destructive/blast-radius approval gates, replayed-trace validation, event replay.
- Out: SRE classification, generation internals, bounded repair internals, real deployment runtime.

## Proof command

```powershell
npm.cmd test -- src/draft/technical-proofs/live-fix-gated-candidate-contract/test/live-fix-gated-candidate.test.ts
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Live Fix Gated Candidate Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
