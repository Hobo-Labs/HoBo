# HOBO-324 LLM-Fill Proof

This proof records the branch evidence for the M1 LLM-fill stage in the
[generation pipeline](../../generated-stack.md#the-generation-pipeline).

## Acceptance Evidence

- `src/draft/technical-proofs/generation-llm-fill-contract` fills a HOBO-321 scaffold candidate
  into a new `hobo.gen.llm-fill-candidate/v1` artifact.
- A seeded database-provider request emits a filled candidate that targets the
  claimed `hobo:database/postgres@0.1.0` port and emits `gen.CandidateGenerated`.
- Removing material still produces a candidate from authoritative WIT,
  conformance, and Capability Manifest inputs, with lower evidence.
- The frozen prompt records model, seed, prompt digest, authoritative refs, and
  delimited untrusted material for later provenance.
- A prompt-injection hint cannot change the claimed port or capability set and
  does not appear in generated candidate bytes.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\generation-llm-fill-contract test
```
