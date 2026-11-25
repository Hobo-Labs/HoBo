# HOBO-652 Stub Implementation Generation Proof

This executable proof pins S5-07 from
[Plan 23](../../generated-stack.md#plan-23): the Forge generates a full
implementation for a stubbed port from its WIT contract, per-interface
conformance suite, and S5-06 recorded traces; sandbox validation replays every
recorded trace as a regression test before promotion.

## Acceptance Mapping

| Acceptance | Executable proof |
|---|---|
| Stubbed fixture port receives generated implementation passing conformance | `acceptance: stubbed payments port receives generated implementation...` asserts `promoted`, `conformance.ok`, and `impl.Promoted`. |
| All recorded traces reproduce in CI | Same test asserts `traceReplay.ok` and `promotion.reproducedTraces` matches stub fixture trace IDs. |
| Trace mismatch blocks promotion | `adversarial: trace mismatch blocks promotion...` ends `needs-human` with no promotion. |
| Repair budget exhaustion escalates | `adversarial: bounded non-convergence...` emits one `gen.NeedsHuman`. |
| Authoritative WIT cannot be overridden by stub material | `adversarial: contradictory stub material...` rejects port mismatch at parse/run boundary. |
| S5-06 recorded trace adapts into generation input | `integration: HOBO-651 recorded trace adapts...` promotes after adaptation. |

## Boundary

The proof lives in
[`src/draft/technical-proofs/stub-implementation-generation-contract`](../../../../src/draft/technical-proofs/stub-implementation-generation-contract/README.md).
It composes existing generation stage contracts and does not import unmerged S5-04
or S5-06 production packages.

## Verification

```bash
pnpm exec turbo run test --filter ./src/draft/technical-proofs/stub-implementation-generation-contract
```
