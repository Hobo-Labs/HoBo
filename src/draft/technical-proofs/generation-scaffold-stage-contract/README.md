# Generation Scaffold Stage Contract POC

Independent POC for HOBO-321. It pins the M1 scaffold stage from the
generation pipeline: deterministic templates keyed by artifact kind and target
port, with `gen.CandidateGenerated` evidence when a scaffold exists and
`gen.NeedsHuman` when no safe scaffold exists.

## Contract

- Template keys are deterministic and cover the scaffold kinds used by the
  pipeline: provider, implementation, Resource Definition, UI, and ADR-0041
  migration importer.
- `scaffoldGenerationRequest()` consumes the HOBO-307 `GenRequest` contract and
  emits candidate bytes from authoritative inputs only.
- Candidate refs are content-addressed by SHA-256.
- Material refs are intentionally excluded from scaffold bytes; docs/OpenAPI/TF
  hints belong to the later fill stage.

## Scope Boundaries

This POC does not implement LLM fill, conformance validation, repair, policy
promotion, signing, publishing, a real provider, or a real importer. It only
proves the deterministic scaffold stage and its event handoff.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\generation-scaffold-stage-contract test
npm.cmd test
```


## Architecture Evidence

This package ships the architecture-guard evidence required by
`scripts/check-architecture-guardrails.mjs`:

- `architecture/` — protobuf data shapes and CUE constraints for Generation Scaffold Stage Contract.
- `architecture/pacts/` — PACT contract for the package boundary.
- `ADR.md` — parse-don't-validate and event-architecture evidence.
