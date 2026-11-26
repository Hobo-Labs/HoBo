# Generation Pipeline IO Contract POC

Independent POC for HOBO-307. It pins the M0 contract for the generation
pipeline request/result shapes and the `gen.*` event family.

## Contract

- `hobo.gen.request/v1` separates authoritative inputs from material hints:
  - authoritative: target WIT port, conformance-suite ref, Capability Manifest digest.
  - material: docs/OpenAPI/Terraform/traces, always marked untrusted and sanitized.
- `hobo.gen.result/v1` records candidate, validation report, provenance, and gate decision refs by digest.
- `gen.Requested`, `gen.CandidateGenerated`, `gen.Validated`, `gen.ValidationFailed`,
  `gen.SafetyRejected`, `gen.Repaired`, `gen.NeedsHuman`, and `gen.Certified`
  validate against the Plan 11 event envelope.
- `rebuildGenerationRun()` folds a stream from zero into the same view produced by
  live appends, preserving every candidate and the final decision.

## Scope Boundaries

This POC does not implement scaffold/fill/validate/repair/certify engines, a
Firecracker runner, a training optimizer, signing infrastructure, or a Registry
publisher. It only makes the IO contract, replay view, and adversarial no-ungated
generation cases executable.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\generation-pipeline-io-contract test
npm.cmd test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Generation Pipeline Io Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
