# HOBO-338 Built-in OPTO Training Engine Proof

This executable proof backs [Plan 23](../../generated-stack.md#plan-23) and
[ADR-0025](../../adr/03-data-plane.md#adr-0025): the built-in
`training-engine` optimizer consumes trajectories plus a rubric plus a contract
and returns a candidate rewrite without creating a new trust path.

## Acceptance Mapping

| Requirement | Executable proof |
|---|---|
| Seeded low-baseline method produces a candidate that improves the offline held-out rubric. | `seeded low-score method produces a replayable in-region candidate that improves held-out rubric` asserts baseline `1/3`, candidate `1`, and threshold/improvement pass flags. |
| Candidate rewrite stays bounded by the marked generated region. | The same acceptance test asserts the edit offsets match the generated region, and `optimizer conformance refuses edits outside the marked generated region` rejects an out-of-region optimizer through the HOBO-317 conformance pass. |
| Run is replayable. | The acceptance test reruns the same request and asserts byte-stable candidate JSON, stable replay digest, valid `training.*` events, and deterministic replay projection. |
| Reward hacking is blocked by the contract pass. | `reward-hacking candidate is rejected by contract pass instead of being accepted on score` rejects a high-scoring candidate that returns the forbidden `refund-approved` output. |
| Built-in optimizer remains behind the `training-engine` port. | `built-in optimizer implements the training-engine port adapter shape` uses `optimizeTrainingCandidate()` against the built-in adapter id. |

## Boundary

The proof lives in
[`src/draft/technical-proofs/built-in-opto-training-engine-contract`](../../../../src/draft/technical-proofs/built-in-opto-training-engine-contract/README.md).
It consumes the HOBO-317 port contract, HOBO-335 trajectory shape, and HOBO-309
promotion-gate discipline, but remains an independent draft POC.

Scope kept out: Agent Lightning / Microsoft Trace adapters, storage of promoted
candidates, policy-engine internals, live-eval scoring runtime, and ADR-0048
region-persistence.

## Verification

```powershell
npm.cmd --prefix src\draft\technical-proofs\built-in-opto-training-engine-contract test
npm.cmd test
npm.cmd run docs:cli-lint
npm.cmd run docs:design-lint
node scripts\validate-traceability.ts
git diff origin/main...HEAD --check
```
