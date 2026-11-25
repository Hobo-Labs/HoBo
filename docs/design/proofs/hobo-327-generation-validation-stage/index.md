# HOBO-327 Generation Validation Stage Proof

This proof maps HOBO-327 to an executable POC in
`src/draft/technical-proofs/generation-validation-stage-contract`.

## Acceptance Mapping

- Known-good candidate passes: the focused test emits `gen.Validated`, validates
  the digest-addressed report, and replays it through the generation run fold.
- One failing conformance assertion emits `gen.ValidationFailed` with
  `conformance:<assertion-id>` in the failing set.
- Replayed trace divergence emits `gen.ValidationFailed` with
  `trace:<trace-id>` even when conformance is green.
- The validation stage rejects non-HOBO-320 no-egress sandbox profiles before a
  candidate can pass.

## Adversarial Mapping

- A candidate that passes conformance but returns different replay outputs fails
  through the trace diff path.
- A candidate claiming a different suite, or a runner returning a suite/port the
  stage did not run, is rejected with `validation.candidate_suite_mismatch` or
  `validation.suite_mismatch`.

## Scope Boundary

The proof stays contract-only. It does not implement `@hobo/conformance`, the
sandbox runner, trace capture, repair, promotion, or provider publishing.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\generation-validation-stage-contract test
```
