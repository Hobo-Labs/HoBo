# System Failure Classifier Contract POC

Independent POC for HOBO-239. It pins the M0 contract for translating system-level failures into a small taxonomy and strategy descriptor consumed by later saga, deploy-gate, alerting, and SRE slices.

## Contract Surface

- `failureClasses`: `transient`, `durable-recoverable`, `partial-failure`, `poison`, `drift`, `split-brain`
- `failureStrategies`: one descriptor per class:
  - transient -> capped backoff with jitter inside a retry budget
  - durable-recoverable -> event-log replay/resume
  - partial-failure -> saga compensation in reverse topological order
  - poison -> `Failed(fatal)` with no retry
  - drift -> resync via `heal`, `propose`, or `ignore`
  - split-brain -> leases and quorum-fenced append
- `classifyFailure(error, context)`: pure boundary from error/context to class + strategy
- `crossesNoGoThreshold(classifications, descriptor)`: descriptor evaluator only; no compensation engine
- `makeClassificationEvent(...)`: stable `failure.Classified` event payload

## Scope Boundaries

This POC intentionally does not implement the membrane taxonomy, compensation algorithm, drift loop, or SRE auto-fix applier. It maps their signals into the system-level contract only.

## Verification

```powershell
npm.cmd test
npm.cmd --prefix src\draft\technical-proofs\system-failure-classifier-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for System Failure Classifier Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
