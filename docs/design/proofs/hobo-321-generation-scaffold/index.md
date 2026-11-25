# HOBO-321 Generation Scaffold Proof

This proof records the branch evidence for the M1 scaffold stage in the
[generation pipeline](../../generated-stack.md#the-generation-pipeline) and the
[ADR-0041](../../adr/07-portability-extensibility.md#adr-0041) migration-importer
skeleton hook.

## Acceptance Evidence

- `src/draft/technical-proofs/generation-scaffold-stage-contract` exposes a template registry
  keyed by artifact kind and target port.
- A database-provider `GenRequest` emits deterministic scaffold bytes plus a
  valid `gen.CandidateGenerated` event.
- An unsupported artifact kind and port pair emits `gen.NeedsHuman` with
  `scaffold.template.missing`, rather than guessing.
- Material refs are excluded from scaffold bytes, so untrusted hints cannot
  override the authoritative WIT/conformance/capability contract at this stage.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\generation-scaffold-stage-contract test
npm.cmd test
```
