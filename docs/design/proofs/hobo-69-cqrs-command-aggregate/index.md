# HOBO-69 CQRS Command Aggregate Proof

This proof backs [PLAN-11](../../data-plane.md#plan-11),
[PLAN-32](../../data-plane.md#plan-32), and
[ADR-0053](../../adr/03-data-plane.md#adr-0053).

The executable POC in
[`src/draft/technical-proofs/cqrs-command-aggregate-contract`](../../../../src/draft/technical-proofs/cqrs-command-aggregate-contract)
proves the M1 write-path boundary:

- `command(type, { key, initialState, fold }, handler)` provides a typed command surface;
- handlers run against `ctx.state`, the aggregate write-model fold;
- invariant rejection leaves the stream unchanged;
- `ctx.emit` returns the aggregate event `seq` and appends under optimistic `expectedSeq`;
- two same-aggregate writers using the same observed `seq` result in one append and one stale
  `expectedSeq` rejection;
- naked emit appends a fact without aggregate state or invariant checks;
- command handlers cannot call `step` or external writes inside the aggregate boundary;
- stale fence tokens cannot append;
- implicit command execution cannot bypass a live aggregate fence.

Scope kept out: ActorHost lease/passivation implementation, projection/read-model folds,
reads-your-writes advancement, sagas, and lane-aware fork-on-touch.
