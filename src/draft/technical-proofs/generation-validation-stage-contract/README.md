# Generation Validation Stage Contract POC

Independent POC for HOBO-327. It pins the generation pipeline validation
stage that loads a candidate, runs the claimed `@hobo/conformance` suite under
the HOBO-320 no-egress sandbox contract, replays recorded traces, and emits the
existing HOBO-307 `gen.Validated` or `gen.ValidationFailed` event.

## Contract

- `runValidationStage()` validates a `hobo.gen.request/v1`, the candidate claim,
  and the no-egress sandbox profile before invoking any validator callbacks.
- Candidate claims must match the authoritative WIT port and conformance suite
  derived from the request. A candidate cannot claim a port or suite the stage
  did not run.
- The conformance runner output is normalized into a validation report with the
  precise failing assertion IDs.
- Trace replay output is normalized into deterministic diffs. A conformance-green
  candidate still fails if replayed traces diverge.
- Validation reports are digest-addressed and referenced by the emitted
  `gen.Validated` / `gen.ValidationFailed` event payload.

## Scope Boundaries

This POC does not implement conformance suites, a Firecracker runner, a WIT host,
trace capture, repair, promotion, signing, or Registry publish. Callers provide
the conformance and replay callbacks as already-sandboxed observations.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\generation-validation-stage-contract test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Generation Validation Stage Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
